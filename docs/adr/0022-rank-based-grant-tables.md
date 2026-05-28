# 0022 — Rank-based grant tables (`roleColumn` + `roleHierarchy`)

**Status:** Accepted
**Date:** 2026-05-28

## Context

`source: 'table'` (ADR-0021) shipped two action shapes: `actionsColumn` (`text[]`) and `actionColumn` (one row per action). Both model **flat, unordered** authorization — a grant either contains an action or it doesn't.

A second common shape is **rank-based**: the grant carries a single ordered role column (e.g. `READER < EDITOR < MANAGER < OWNER`), and authorization is "user has *at least* rank X." Flowchestra's `workspace_grants.role`, `workbench_grants.role`, and `role_grants.role` are all this shape (issue #5). It surfaced during the alpha.2 pilot: every Flowchestra grant table needed a `compileHasGrant` override purely to express rank comparison, which is exactly the kind of consumer-specific SQL the declarative DSL exists to remove.

## Decision

Add a third, mutually-exclusive action shape to `PerResourceGrantTable` and `PolymorphicGrantTable`:

```ts
roleColumn: 'role',
roleHierarchy: ['READER', 'EDITOR', 'MANAGER', 'OWNER'],  // lowest → highest
roleColumnType: '"ResourceRole"',                         // optional cast hint
```

`p.hasGrant('EDITOR', col('workspaceId'))` compiles to a membership test against the **qualifying suffix** of the hierarchy (the requested rank and everything above it):

```sql
<table>.role = ANY(ARRAY['EDITOR', 'MANAGER', 'OWNER']::"ResourceRole"[])
```

The suffix is computed at compile time from `roleHierarchy.indexOf(action)`. `roleColumnType`, when present, is inserted verbatim as `::<type>[]` so enum-typed role columns compare correctly; omit it for plain `text` columns.

**Validation:**
- Exactly one of `actionsColumn` / `actionColumn` / `roleColumn` per table config.
- `roleColumn` requires a non-empty `roleHierarchy` (unique, non-empty entries).
- Every `roleHierarchy` entry must appear in the top-level `actions` vocabulary, so `p.hasGrant(rank, col)` type-checks. (We do **not** require `actions` to *equal* the hierarchy — a schema with multiple rank tables of different hierarchies, e.g. workspace `READER..OWNER` and org `USER..OWNER`, declares the union as `actions`.)
- `roleHierarchy` / `roleColumnType` without `roleColumn` is a config error.
- The requested rank not being in that table's hierarchy throws at compile time.

## Consequences

**Positive**
- Rank-based authz is declarative; the rank-comparison override disappears for consumers with this shape.
- Composes with the ADR-0023 principal disjunction on the same table.
- Compile-time rank-set expansion means zero runtime cost beyond the `= ANY(ARRAY[...])` the consumer would have hand-written.

**Negative**
- The hierarchy is consumer-declared per table; guarddog can't validate it against the actual Postgres enum definition (we don't read the DB at compile time). A hierarchy that disagrees with the enum's value set produces SQL that errors at apply time — surfaced by the e2e, not by `guarddog check`.
- Only string-enumerable ranks are first-class. **Integer/ordinal ranks** are expressible (`roleColumnType: 'int'` + numeric-string hierarchy → `ARRAY['1','2']::int[]`) but not ergonomic. If a consumer needs `role >= 3` range semantics rather than set membership, they still need a `compileHasGrant` override. Deferred until requested.

## Alternatives considered

- **New predicate primitive `p.hasRankAtLeast(...)`.** Cleaner call-site naming, but adds an AST node + core surface for what the existing `hasGrant` + a config flag already expresses. Rejected to keep the predicate vocabulary small; consumers can wrap `hasGrant` in a 1-line helper for readability.
- **Range comparison (`role >= 'EDITOR'`) instead of set membership.** Requires the role column to be an ordered type (enum with a known order, or integer). Set membership via the compile-time-expanded array works for any equality-comparable column and doesn't depend on Postgres enum ordering being defined the way the consumer expects. Chosen.

## References

- [ADR-0021 — Table-backed resource grants](./0021-table-backed-resource-grants.md)
- [ADR-0023 — Principal disjunction](./0023-grant-principal-disjunction.md)
- Issue #5; reference override: `Flowchestra-Frontend/src/server/rls/guarddog/compile-has-grant.ts`
- [`packages/emitter-postgres-rls/src/compile-expr.ts`](../../packages/emitter-postgres-rls/src/compile-expr.ts) — `emitActionClause`
