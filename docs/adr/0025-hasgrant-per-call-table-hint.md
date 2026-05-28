# 0025 — `hasGrant` per-call table hint

**Status:** Accepted
**Date:** 2026-05-28

## Context

`source: 'table'` (ADR-0021) routes `p.hasGrant(action, col('<x>'))` by keying the `tables` map on the scope-column name **globally**. That's unambiguous when each resource is referenced via a distinct FK column (`workspace_id` → `workspace_grants`, `workbench_id` → `workbench_grants`).

It collides for **own-row** grant checks, which key on the primary key — `id` for every table. The first multi-resource consumer (Flowchestra, issue #11) hit this extending past the Workspace-only pilot: a Workspace policy and a Workbench policy both need `p.hasGrant('READER', col('id'))`, routing to `workspace_grants` and `workbench_grants` respectively. Global column-name keying can only map `tables['id']` to one table. Workspaces are top-of-tree for grants (no parent FK to lean on), so the own-`id` handle is unavoidable.

The workarounds both regress: a scoped `compileHasGrant` override just for the self-id case re-introduces exactly what ADR-0022/0023 removed; avoiding own-row checks only works when access is always inherited via a parent FK.

## Decision

Add an optional per-call table hint:

```ts
p.hasGrant('READER', col('id'), { table: 'workspaceId' })
```

`opts.table` names a `tables`-map key. Dispatch:
- **Hint present:** route to `tables[hint]`. Throw at compile time (listing the declared keys) if the hint matches no entry. The hint does **not** route to `fallbackTable`.
- **Hint absent:** unchanged — route by scope-column name, then `fallbackTable`.

The hint carries through as `tableHint` on the `hasGrant` AST node and is consumed by `defaultCompileHasGrantTable`. Two quantities that were conflated are now separate:
- **registration key** (the `tables` map key) — the default for the grant table's `resourceIdColumn`.
- **outer scope column** (the column from the `hasGrant` call) — the outer-row correlation side, qualified with the policy's table.

They coincide in the no-hint path (the key *is* the scope column); they diverge when a hint routes a `col('id')` check to a table registered under `workspaceId` — `workspace_grants."workspaceId" = workspaces.id`.

The hint is a plain `string`, validated at compile time. **Type-safe autocomplete on the key (alpha.5):** threading the declared `tables` keys as a generic through `Guarddog` → `PredicateBuilder` is a DSL-wide change (7 builder classes + a second generic on `ResourceGrantsDefinition`), so it's decoupled into a follow-up. Compile-time *safety* (throw on unknown key) ships now; *autocomplete* lands separately so the generics refactor can be reviewed without a behavior change in the diff.

## Consequences

**Positive**
- Multi-resource consumers with own-row grant checks stay fully declarative — no per-table `compileHasGrant` override for the self-id case. Closes the last gap (with #5/#6) to override-free.
- Backward compatible: omitting `opts.table` preserves the alpha.2/alpha.3 behavior exactly. The registration-key/scope-column split is behaviour-preserving for the no-hint path (verified by the existing suite).
- Explicit at the call site — the disambiguation is visible in the policy, not hidden in routing config.

**Negative**
- No autocomplete yet; a typo'd key is caught at compile (migrate) time, not in the editor. Acceptable interim — the error lists the valid keys.
- The hint only addresses `tables` routing; it doesn't reach `fallbackTable` (by design — polymorphic routing already disambiguates by `scopeColumnTypeMap`).
- `compileHasGrant` overrides don't receive the hint (their signature is unchanged). Overrides already have `ctx.table` for disambiguation, so this isn't a gap; a 4th param could be added additively later if needed.

## Alternatives considered

- **Route the built-in dispatch by `(scopeColumn, ctx.table)` automatically** instead of an explicit hint. Implicit and config-shape-changing (the `tables` map would need re-keying by model/policy table). The explicit per-call hint is more predictable and a smaller change. Rejected.
- **Require the hint always (drop scope-column-name routing).** Breaks every alpha.2/alpha.3 call site and is noisier for the common distinct-FK case. Rejected — hint is opt-in.

## References

- Issue #11
- [ADR-0021 — Table-backed resource grants](./0021-table-backed-resource-grants.md), [ADR-0022](./0022-rank-based-grant-tables.md), [ADR-0023](./0023-grant-principal-disjunction.md)
- [`packages/emitter-postgres-rls/src/compile-expr.ts`](../../packages/emitter-postgres-rls/src/compile-expr.ts) — `defaultCompileHasGrantTable`, `emitGrantExists`
- [`packages/core/src/predicate.ts`](../../packages/core/src/predicate.ts) — `hasGrant`
