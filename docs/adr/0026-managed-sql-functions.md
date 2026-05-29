# 0026 — guarddog-managed SQL functions (`defineFunctions`)

**Status:** Accepted
**Date:** 2026-05-28

## Context

ADR-0001 commits to **self-contained emission**: the emitted SQL never depends on consumer-side helper functions or an `app.*` schema the consumer provisions out-of-band. For simple predicates (tenant floor, claim equality) inlining is fine. But production RLS leans on helper functions that encapsulate non-trivial, *reused* authorization logic, and inlining those across every policy duplicates the logic N times — turning a one-line change into an N-policy rewrite.

The driving consumer (Flowchestra, issue #15) has 14 `app.*` functions backing 93 policies: a shared rank-ordinal mapper referenced by every grant check, a claim accessor, and FGAC predicates with bespoke shapes the declarative grant config (ADR-0021/0022/0023) can't express — e.g. a *creator-implicit-OWNER* clause (`EXISTS (… WHERE id = … AND user_id = …) OR EXISTS (grant join …)`) and custom `LEFT JOIN` group-membership shapes.

The declarative `source: 'table'` config covers rank + group disjunction, but not bespoke logic, shared sub-functions, or custom JOIN shapes. The only alternatives were inlining (duplicated 93×, ADR-0001-clean but unmaintainable) or `p.raw(...)` (loses the typed, diffable, dependency-ordered value). Both are compromises.

## Decision

guarddog **manages** SQL functions as first-class emitted objects. A new `defineFunctions` primitive declares them; guarddog emits the `CREATE SCHEMA` + `CREATE OR REPLACE FUNCTION` DDL, the `GRANT EXECUTE` grants, and diffs them across runs like policies.

This *resolves* the ADR-0001 tension rather than violating it: emission stays self-contained because guarddog emits the functions too. It's "guarddog owns the helpers," not "guarddog depends on external helpers."

```ts
export default defineSchema({
  functions: defineFunctions({
    schema: 'app',
    fns: {
      resource_role_ordinal: {
        args: [{ name: 'role_text', type: 'text' }],
        returns: 'integer',
        volatility: 'immutable',
        parallel: 'safe',
        body: `SELECT CASE role_text WHEN 'OWNER' THEN 4 ... END`,
      },
      user_has_workspace_grant: {
        args: [
          { name: 'workspace_id_in', type: 'text' },
          { name: 'user_id_in', type: 'text' },
          { name: 'min_role_in', type: 'text', default: 'NULL' },
        ],
        returns: 'boolean',
        volatility: 'stable',
        security: 'definer',
        searchPath: ['pg_catalog', 'public'],
        dependsOn: ['resource_role_ordinal'],   // drives emission order
        grants: { execute: ['app_user', 'app_system'] },
        body: `SELECT EXISTS (...)`,
      },
    },
  }),
  policies(guard) {
    guard.model('Workspace').policy('app_user').update({
      using: (p) => p.and(
        p.claim('tenant_id').eq(col('tenant_id')),
        p.fn('user_has_workspace_grant', col('id'), p.claim('sub'), 'MANAGER'),
      ),
      check: (p) => p.fn('user_has_workspace_grant', col('id'), p.claim('sub'), 'MANAGER'),
    })
  },
})
```

**Authoring.** `defineFunctions({ schema, fns })` validates each function (non-empty body/returns, unique arg names, defaulted args trailing per Postgres, valid `language`/`volatility`/`parallel`/`security` enums, `dependsOn` references resolve and are acyclic). All function attributes are first-class: `language` (sql/plpgsql), `volatility`, `parallel`, `security` (definer/invoker), `searchPath`, `dependsOn`, and per-role `grants.execute`.

**Reference.** `p.fn(name, ...args)` compiles to `<schema>.<name>(<compiled args>)`. The name autocompletes against the declared `fns` keys and **arity is checked** via a mapped tuple type — `TFunctions` threads from `defineFunctions` → `Guarddog` → the predicate builder, parallel to `TGrantTableKeys` (ADR-0025/#12). Args may be expressions (`col(...)`, `p.claim(...)`, nested `p.fn(...)`) or SQL literals (auto-wrapped). An unknown name or wrong arity is a compile-time type error; a `p.fn(...)` with no functions schema configured throws at emit time.

**Per-argument PG-type checking is out of scope.** `FluentExpr` is untyped at the SQL level (an `Expr` AST node carries no Postgres type), so checking that arg 1 is `text` not `uuid` would require a full expression-layer type rearchitecture. v1 delivers name autocomplete + arity; per-arg typing is a possible future enhancement, not a v1 gap.

**Lifecycle (signature-aware diffing).** Functions flow through the same Op-union lifecycle as everything else (ADR-0020): `compileToOps` emits `create-schema` + dependency-ordered `create-function` + `grant-execute` ops; `diffStates` compares two states and emits the minimal transform. The diff is **signature-aware**:

- present in target only → `CREATE OR REPLACE`
- present in current only → `DROP`
- both, **signature changed** (arg names, arg types, or return type — the parts `CREATE OR REPLACE` can't alter) → `DROP` + `CREATE`, and EXECUTE grants are re-emitted (the DROP wipes them)
- both, **body/attribute-only change** → `CREATE OR REPLACE` (grants preserved; a single removed role emits an explicit `REVOKE`)

Op ordering keeps replay safe: policies drop before the functions they call; functions create after their schema and before the policies that call them; functions emit in `dependsOn` topo-order (reverse for drops). `EXECUTE` on a function is useless without `USAGE` on its schema, so a `grant-execute` op also emits a once-per-`(schema, role)` `GRANT USAGE ON SCHEMA`.

## Consequences

**Positive**
- Bespoke authorization logic (creator-implicit-OWNER, custom JOINs, shared sub-functions) lives in **one** place, typed and diffed by guarddog — the last piece for a consumer to go fully declarative instead of duplicating logic 93× or dropping to unmanaged `rawSql`.
- Honors ADR-0001: the emitted migration provisions the functions, their schema, and their grants. Nothing external is assumed.
- Signature-aware diffing produces correct, minimal, idempotent migrations; `CREATE OR REPLACE` for the common body tweak, `DROP`+`CREATE`+re-grant only when Postgres requires it.
- Fully backward compatible: `functions` is optional and `TFunctions` defaults to unconstrained, so schemas without functions are unchanged.

**Negative**
- Function bodies are opaque trusted strings (same trust level as `p.raw`) — guarddog does not parse or validate SQL inside them. A body that references a dropped column fails at migrate/apply time, not at compile.
- No per-argument PG-type checking (see above). A type-mismatched arg surfaces as a Postgres error at apply time.
- Schemas are create-only (never dropped) since a schema may hold objects guarddog doesn't manage; a removed `functions` schema leaves an empty schema behind. Acceptable — an empty schema is inert.
- `searchPath`/`security: definer` correctness is the author's responsibility; guarddog emits what's declared without reasoning about the security implications of a definer function.

## Alternatives considered

- **Keep inlining only.** ADR-0001-clean but forces N-way duplication of shared logic; a one-line change becomes an N-policy rewrite. Rejected — doesn't scale past a handful of policies.
- **`p.raw(...)` for the bespoke cases.** Works but loses the typed call, the dependency ordering, the grant management, and the diff. Rejected as the *primary* mechanism (still available as the escape hatch).
- **Depend on consumer-provisioned `app.*` functions** (the pre-existing real-world pattern). Violates ADR-0001 outright — emission would silently assume functions guarddog didn't emit. Rejected.
- **Per-argument PG-type checking now.** Requires typing the whole expression layer; large, speculative, and orthogonal to the core value (managing the functions). Deferred.

## References

- Issue #15
- [ADR-0001 — Policy compiler, not runtime middleware](./0001-policy-compiler-not-runtime-middleware.md) (self-contained-emission principle)
- [ADR-0019 — Three permission layers + per-resource jsonb permissions](./0019-three-permission-layers-and-resource-permissions.md)
- [ADR-0020 — Functional lifecycle over an Op union](./0020-functional-lifecycle-over-op-union.md)
- [ADR-0025 — `hasGrant` per-call table hint](./0025-hasgrant-per-call-table-hint.md) — the `TGrantTableKeys` thread this mirrors
- [`packages/core/src/function-defs.ts`](../../packages/core/src/function-defs.ts) — `defineFunctions`, `orderFunctions`
- [`packages/core/src/predicate.ts`](../../packages/core/src/predicate.ts) — `p.fn(...)`
- [`packages/core/src/lifecycle.ts`](../../packages/core/src/lifecycle.ts) — `appendFunctionOps`, `diffFunctions`, `diffFunctionGrants`
- [`packages/cli/src/render-ops.ts`](../../packages/cli/src/render-ops.ts) — function DDL rendering
