# 0032 — Restrictive policy support (`.restrictivePolicy()` + `.isolation()`)

**Status:** Accepted (implemented)
**Date:** 2026-05-29

## Context

Postgres has two policy kinds:

- **`PERMISSIVE`** policies are OR'd together. Adding one **widens** access — every additional permissive is another path through the gate.
- **`RESTRICTIVE`** policies are AND'd with every other policy (permissive or restrictive). They form an **inescapable floor**: no permissive can route around them.

Until this ADR every policy guarddog emits is permissive. That choice is correct when each `(role, command)` has exactly one policy and the policy expresses the entire access rule. It stops being correct the moment a second permissive on the same `(role, command)` needs to coexist — break-glass roles, support-tools roles, future shared-link primitives, cross-org visibility, etc. The widening hazard then becomes the dominant failure mode:

- The conceptual model most consumers carry is `(HARD floor) AND (SOFT access)`. The HARD floor is tenant scope + soft-delete; the SOFT access is FGAC, owner checks, role visibility, etc.
- Without restrictive support the floor must be **inlined and AND'd inside every permissive policy's USING**. The moment one is missed, the new permissive OR's with the existing → cross-tenant leak. The bug class is *omitting* the floor in a permissive: a missing AND in a 200-line file, in a PR that did 12 other things, on a Tuesday.
- "Be disciplined and remember to inline the floor everywhere" is exactly the kind of author-discipline failure mode the rest of guarddog removes by construction (typed predicates, named-policy duplicate guard, lint coverage). It should be removed here too.

ADR-0001 (permissive-only) noted this gap as future work. ADR-0029 + ADR-0030 + ADR-0031 closed the existing-policy adoption story; #26 closes the structural-shape story.

## Decision

Add restrictive policy support as two builder shapes layered on one primitive:

```ts
// Low-level primitive: explicit role + scope-to-all-verbs predicate.
guard.model('Workspace').restrictivePolicy('public').forAll((p) =>
  p.fn('current_tenant_id').eq(col('tenant_id')).and(p.raw('deleted_at IS NULL'))
)

// Domain-aware sugar (RECOMMENDED for the tenant+soft-delete floor).
// Desugars to `.restrictivePolicy('public').forAll(...)` with auto-name
// `<table>_isolation`. One per table; lint nudges missing ones.
guard.model('Workspace').table('workspaces')
  .isolation((p) =>
    p.fn('current_tenant_id').eq(col('tenant_id')).and(p.raw('deleted_at IS NULL'))
  )
  .policy('app_user')
    .select((p) => /* access only — the floor is already AND'd by the restrictive */)
```

**The single primitive — `forAll`.** A restrictive policy declares one predicate that applies to **every command** (`FOR ALL`). That's what makes it the floor: SELECT, INSERT, UPDATE, DELETE all pass through the same AND. Per-verb restrictives are a possible extension; they're not in this ADR (no demonstrated need, and a per-verb restrictive is just a permissive's inverse in practice).

**Two builder shapes** by design:
- `.restrictivePolicy(role)` is the primitive — escape hatch for unusual roles or when the floor needs an explicit non-public TO.
- `.isolation(fn, opts?)` is the sugar — the **convention** for the tenant + soft-delete floor. It's `.restrictivePolicy('public').forAll(...)` with the `isolation` flag set so the auto-name resolves to `<table>_isolation`. Most consumers will write only this.

**AST.** `PolicyAst` gains `restrictive?: boolean` (default false = permissive, backward-compatible) and `all?: AllSpec` for the `FOR ALL` clause. A fifth verb token `'all'` is introduced to the `Verb` union so the lifecycle and emitter can dispatch on it the same way they already dispatch on `select`/`insert`/`update`/`delete`. `AllSpec` carries both `using` and `check` so a restrictive can constrain both reads and writes through the same predicate. An `isolation?: boolean` flag rides on `PolicyAst` purely to drive auto-naming; the emitter's behavior depends only on `restrictive` + the `all` spec.

**Op record.** `PolicyOpRecord.restrictive: boolean` is the new field. The existing `(table, name)` keying is unchanged.

**Emit shape.** `CREATE POLICY <name> ON <table> AS RESTRICTIVE FOR ALL TO <role> USING (...) WITH CHECK (...)`. The `AS PERMISSIVE` clause stays omitted for the default permissive case (Postgres defaults to permissive). Idempotency unchanged: every CREATE is preceded by `DROP POLICY IF EXISTS`, so flipping permissive ↔ restrictive at the same name reapplies cleanly.

**Drift.** `computePolicyDrift` already reads `permissive` from `pg_policies`. A new `restrictivenessMismatch` classification reports the case where a policy with the same `(table, name)` exists in both declared and live but has a different permissive/restrictive flag. Treating it as drift forces a reapply rather than silently shipping `permissive` SQL when `restrictive` is intended (or vice versa).

**Lint.** The lint extension surfaces a *non-failing* `restrictive-policy-declared` informational warning whenever a restrictive is declared, with the auto-name target — same convention as ADR-0031's `policy-uses-declared-name`. The author signal is "yes, this is on purpose; here's the catalog name." A future ADR may add `isolation-missing` coverage; this ADR keeps lint quiet about that because the right-shape isolation floor is opinionated and not all consumers need one.

**Resolution rule for restrictive auto-names.** When `restrictive=true` and `isolation=true`, the auto-gen name is `<table>_isolation`. Otherwise it's `<table>_<role>_<verb>` (with `verb='all'` for a non-isolation restrictive). The duplicate-name guard from ADR-0031 catches collisions at compile time.

## Consequences

**Positive**
- The HARD floor is expressed once per table and enforced by Postgres semantics, not by author discipline. Future permissives — break-glass, support role, shared-link — cannot escape it.
- Backward compatible: every existing policy stays permissive; nothing renames, nothing renumbers, no migration required.
- Pairs cleanly with ADR-0031 (`.named()`) for legacy-name parity: a consumer with `tenant_isolation` written by hand can adopt with `.isolation((p) => …, { name: 'tenant_isolation' })` for an atomic in-place upgrade.
- The same primitive composes with ADR-0026 (managed SQL functions): the floor is typically `p.fn('current_tenant_id').eq(col('tenant_id'))`, which keeps the predicate readable and stable across schema renames.

**Negative**
- Two builder shapes for one concept. Mitigated: `.isolation()` is *the* recommended shape; `.restrictivePolicy()` is the escape hatch the lint nudges away from when it's used for the tenant floor.
- Adding a `FOR ALL` predicate to every command has a tiny per-query cost (one extra AND'd subexpression in the plan). In practice the floor is `tenant_id = constant AND deleted_at IS NULL`, indexable, and dominated by the rest of the predicate. Documented as a non-issue.
- A consumer who restricts SELECT and INSERT through different floors (rare) needs two restrictive policies. The primitive supports this — declare two `.restrictivePolicy(role).forAll(...)` with distinct names — but the sugar `.isolation()` does not. Acceptable: the sugar is intentionally the 90% case.

## Alternatives considered

- **Inline the floor in every permissive USING clause.** The status quo. Rejected — it's exactly the author-discipline failure mode this ADR removes. The lint can flag *known* floors but cannot detect missing-floor when the floor is not declared anywhere.
- **One restrictive per `(role, command)` instead of `FOR ALL`.** Symmetric to permissive's per-verb shape, but the floor is the same predicate across all verbs by construction. Per-verb restrictive multiplies the surface area without buying anything. Rejected.
- **`AS RESTRICTIVE` as a boolean on the existing `.policy()` builder.** Would let one builder mix permissive and restrictive specs across verbs on the same `(model, role)`. Rejected — it muddies the mental model (one builder = one Postgres policy) and the AND/OR semantics are different enough that the API should make them visibly different.
- **Auto-promote `.isolation()` to `FOR ALL TO PUBLIC` *without* a flag in the AST.** Then the auto-name is just `<table>_public_all`. Rejected — `<table>_isolation` is the convention everyone uses and search-grepping logs for "isolation" is more useful than for "public_all."

## References

- [ADR-0001 — Policy compiler, not runtime middleware](./0001-policy-compiler-not-runtime-middleware.md) — the permissive-only baseline this extends
- [ADR-0026 — Managed SQL functions](./0026-managed-sql-functions.md) — `p.fn('current_tenant_id')` is the typical floor primitive
- [ADR-0029 — Handling existing (foreign) RLS policies](./0029-handling-existing-rls-policies.md) — drift detection this ADR extends
- [ADR-0031 — User-declared policy names](./0031-user-declared-policy-names.md) — the legacy-name pairing
- Issue #26
- Postgres docs: [`CREATE POLICY ... AS { PERMISSIVE | RESTRICTIVE }`](https://www.postgresql.org/docs/current/sql-createpolicy.html)
- [`packages/core/src/ast.ts`](../../packages/core/src/ast.ts) — `PolicyAst.restrictive` / `all` / `isolation`
- [`packages/core/src/guarddog.ts`](../../packages/core/src/guarddog.ts) — `ModelBuilder.restrictivePolicy()` + `.isolation()`
- [`packages/emitter-postgres-rls/src/emit.ts`](../../packages/emitter-postgres-rls/src/emit.ts) — `AS RESTRICTIVE FOR ALL` emission
- [`packages/cli/src/drift.ts`](../../packages/cli/src/drift.ts) — `restrictivenessMismatch`
