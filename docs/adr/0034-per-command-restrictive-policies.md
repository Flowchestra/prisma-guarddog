# 0034 — Per-command restrictive policies (`.forSelect()` / `.forInsert()` / `.forUpdate()` / `.forDelete()`)

**Status:** Accepted (implemented)
**Date:** 2026-05-30

## Context

ADR-0032 shipped restrictive policies with a single `.forAll(fn)` builder that emits as `AS RESTRICTIVE FOR ALL` — one predicate applied as both `USING` and `WITH CHECK` to SELECT, INSERT, UPDATE, and DELETE. That's the right shape for invariants that apply uniformly to every access path: tenant isolation, org boundary, hard ownership floors.

It stops being the right shape the moment an invariant is **command-asymmetric**. The canonical example is soft-delete:

- The invariant *"no SELECT of soft-deleted rows"* is real and desirable as an inescapable floor.
- The same predicate as a `WITH CHECK` on UPDATE/DELETE **breaks undelete** — toggling `deleted_at` back to `NULL` is a legitimate write operation against a soft-deleted row, and `.forAll(p => p.raw('deleted_at IS NULL'))` denies it.

Consumers today have to pick one of two bad options:

1. **Put soft-delete in `.forAll()`.** The restrictive denies writes on soft-deleted rows. Breaks undelete via the policy-bound role; every undelete path needs `BYPASSRLS` or a `app_system` impersonation.
2. **Leave soft-delete out of restrictive entirely.** Inline it as a permissive `USING` clause on every SELECT policy. Loses the inescapable-floor property of restrictive: any future permissive SELECT (break-glass, support tools, shared-link) that forgets the inline floor leaks soft-deleted rows.

Postgres semantics already match the desired shape: `CREATE POLICY ... AS RESTRICTIVE FOR <command>` is the catalog representation, and `pg_policies.cmd` is the per-row command set. The DSL just needs the right builder shape to express it.

## Decision

Mirror the permissive `PolicyBuilder` verb-method shape on `RestrictivePolicyBuilder`:

```ts
.restrictivePolicy('public', 'no_soft_deleted_select')
  // USING only, FOR SELECT — the canonical soft-delete shape.
  .forSelect((p) => p.raw('deleted_at IS NULL'))

.restrictivePolicy('public', 'tenant_writes')
  .forInsert({ check: (p) => p.claim('tenantId').eq(col('tenant_id')) })  // WITH CHECK only, FOR INSERT
  .forUpdate({                                                            // both, FOR UPDATE
    using: (p) => p.claim('tenantId').eq(col('tenant_id')),
    check: (p) => p.claim('tenantId').eq(col('tenant_id')),
  })
  .forDelete((p) => p.claim('tenantId').eq(col('tenant_id')))             // USING only, FOR DELETE
```

`.forAll(fn)` is preserved as-is for backward compatibility and remains the recommended shape for invariants that apply uniformly (the common case — e.g., tenant boundary).

### Mutual exclusion within one builder

A restrictive builder holds **either** an `all`-spec **or** any subset of per-verb specs — never both. Mixing `.forAll(...)` with `.forSelect(...)` (or any other per-verb method) on the same builder throws at the second call with a clear message naming the conflict. Rationale: `FOR ALL` and `FOR SELECT/INSERT/UPDATE/DELETE` are catalog-distinct in Postgres; mixing them on one DSL builder would emit two policies under one builder identity, which the slot mechanism ([ADR-0033](./0033-named-slots-for-restrictive-policies.md)) is the right tool for instead.

### AST shape

`PolicyAst` already carries optional `select?: SelectSpec`, `insert?: InsertSpec`, `update?: UpdateSpec`, `delete?: DeleteSpec`, plus `all?: AllSpec` and `restrictive?: boolean`. Per-verb restrictive policies simply set the existing per-verb spec fields **on a restrictive AST** (where `restrictive: true` is already set). The shapes — `SelectSpec`/`InsertSpec`/`UpdateSpec`/`DeleteSpec` — are reused verbatim, including their optional `name?: string` override for declared-name parity.

The lifecycle and emitter already iterate over the per-verb specs to emit one `CREATE POLICY` per declared verb; the only new behavior is to thread the `restrictive: true` flag through the existing per-verb emission paths so they render `AS RESTRICTIVE FOR <SELECT|INSERT|UPDATE|DELETE>` instead of plain permissive.

### Auto-name resolution

| Form | Auto-name |
| --- | --- |
| `.forAll(fn)` (default slot) | `<table>_<role>_all` *(alpha.14 preserved)* |
| `.forAll(fn)` (with slot, ADR-0033) | `<table>_<role>_<slot>` |
| `.forSelect(fn)` (default slot) | `<table>_<role>_select` |
| `.forSelect(fn)` (with slot) | `<table>_<role>_<slot>_select` |
| `.forInsert(spec)` / `.forUpdate(spec)` / `.forDelete(spec)` | `<table>_<role>_<verb>` *(or with slot prefix)* |

The slot when present prefixes the verb — same convention as the existing permissive naming so operators reading `pg_policies` see a consistent shape across permissive and restrictive policies.

### Why no `.isolation`-level sugar for per-command

`.isolation()` is the **uniform tenant-floor** sugar. The whole motivation for per-command restrictives is asymmetry — different commands need different predicates. A `.isolation('soft_delete', { forSelect, forUpdate })` form would mix two opposing intents at one call site and obscure the asymmetry it exists to express. The low-level `.restrictivePolicy(role, slot)` + per-verb methods is the right shape; `.isolation(slot, fn)` stays sugar for the symmetric tenant floor.

## Consequences

**Positive**

- The SELECT-only soft-delete archetype becomes idiomatic: `.restrictivePolicy('public', 'no_soft_deleted_select').forSelect(p => p.raw('deleted_at IS NULL'))`. Undelete flows work; reads can't escape the floor.
- API shape mirrors the existing permissive `PolicyBuilder` verb methods exactly, including the `{ name }` declared-name override per [ADR-0031](./0031-user-declared-policy-names.md). Authors don't learn a second mental model for restrictive.
- Composes cleanly with [ADR-0033](./0033-named-slots-for-restrictive-policies.md): each `(model, dbRole, slot)` builder holds either `.forAll` or any subset of per-verb specs. Two distinct invariants in two slots is the right shape; both being per-command across the same slot is the right shape; mixing within one slot throws.
- Backward compatible. `.forAll(fn)` calls keep working; the mutex guard only fires when the same builder receives both forms.
- Drift, lint, and diff all use the existing per-verb paths — `restrictivenessMismatch` (ADR-0032) catches a per-verb permissive ↔ restrictive flip just like it catches the all-verb flip, with no new code.

**Negative**

- Mutex guard is runtime, not type-level. A consumer who chains `.forAll(...).forSelect(...)` only learns at the second call. Mitigated by the clear error message and the fact that this is a pure authoring-time mistake that surfaces in `guarddog check` long before a migration is generated.
- The auto-name convention has a slight asymmetry: `.forAll(fn)` with no slot keeps the alpha.14 `<table>_<role>_all`, while `.forSelect(fn)` is `<table>_<role>_select`. Both convention-consistent in isolation, but adopting an existing schema may need `.named(...)` for both forms separately. Documented; the `.named()` mechanism (ADR-0031) is exactly the right escape hatch.

## Alternatives considered

- **One restrictive per verb, no `.forAll`.** Symmetric with the permissive `.policy()` builder, but the common case is genuinely "this invariant applies everywhere," and `.forAll` is more direct than four redundant calls. Rejected; keep both.
- **Implicit fall-through: `.forAll(fn).forSelect(g)` means "use `fn` for everything *except* SELECT, where `g` overrides."** Too clever; the catalog-distinct nature of `FOR ALL` and `FOR <command>` doesn't lend itself to this semantic. The same effect comes from two slot policies (`.restrictivePolicy('public', 'base').forAll(fn)` + `.restrictivePolicy('public', 'select_override').forSelect(g)`) — readable, explicit, idiomatic.
- **A separate `.restrictivePolicy(role).forAllExceptSelect(fn)` shape for the soft-delete case.** Too narrow; doesn't generalize. Rejected.
- **Allow mixing `.forAll` with per-verb on the same builder, emit one policy per declared verb-spec.** Rejected — silently overrides intent; the mutex guard makes the asymmetry explicit at the authoring site.

## References

- [ADR-0032 — Restrictive policy support](./0032-restrictive-policy-support.md) — the alpha.14 baseline (`.forAll` only)
- [ADR-0033 — Named slots for restrictive policies](./0033-named-slots-for-restrictive-policies.md) — the registry handle that lets multi-invariant shapes coexist; per-command restrictives use slot keys the same way
- [ADR-0031 — User-declared policy names](./0031-user-declared-policy-names.md) — the `{ name }` override inherited by every per-verb method
- Issue #30
- [`packages/core/src/guarddog.ts`](../../packages/core/src/guarddog.ts) — `RestrictivePolicyBuilder.forSelect / forInsert / forUpdate / forDelete` + the mutex guard
- [`packages/core/src/lifecycle.ts`](../../packages/core/src/lifecycle.ts) — per-verb emission paths thread `restrictive: true`
- [`packages/emitter-postgres-rls/src/emit.ts`](../../packages/emitter-postgres-rls/src/emit.ts) — `AS RESTRICTIVE FOR <verb>` on existing per-verb emission
