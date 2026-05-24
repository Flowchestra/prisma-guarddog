# 0021 — Table-backed resource grants (`source: 'table'`)

**Status:** Accepted
**Date:** 2026-05-24

## Context

Phase 1 shipped `defineResourceGrants({ source: 'claims' })`: grants encoded as a JSONB blob in the session JWT, resolved at predicate-compile time as a containment check against `current_setting('<accessor>', true)::jsonb -> 'grants' -> '<action>'`. Convenient for stateless deployments, but it doesn't cover the most common shape we see in real consumer codebases — **grants stored as Postgres rows**, joined into policy predicates via `EXISTS` sub-queries.

Two concrete shapes turn up in practice:

1. **Per-resource grant tables** (`workspace_grant`, `workbench_grant`, `org_grant`) — denormalized, one table per resource type. The principal column + actions storage shape varies by team but follows predictable conventions. Common in apps with a small number of resource types and ergonomic indexing requirements.
2. **Polymorphic grant tables** (`resource_grant` with `resourceType` discriminator) — one row format covers all resources. Common in CMS-shaped apps or where grants are managed centrally.

Many consumers (Flowchestra included) maintain **both**: dedicated tables for the high-volume resources (Workspace, Workbench), a polymorphic fallback for smaller or newer resource types.

PLAN.md originally deferred this to Phase 2 alongside FDW support and `.masks()`. We're promoting it forward into the `0.1.0-alpha.x` line because:
- It's the gating constraint for Flowchestra adoption.
- The lift is small: predicate AST already supports `hasGrant`, the emitter already has a pluggable `compileHasGrant` override hook, and the declarative surface extension is mechanical.
- Phase 2 retains FDW + masking + Supabase importer as its actual flagship items.

## Decision

Extend `defineResourceGrants` with a discriminated `source: 'table'` branch:

```ts
defineResourceGrants({
  source: 'table',
  actions: ['edit', 'admin'] as const,

  // Per-scope-column overrides. Keyed by the column passed to
  // `p.hasGrant(action, col('<scopeColumn>'))`. Dispatched first.
  tables: {
    workspaceId: {
      name: 'workspace_grant',
      principalColumn: 'userId',
      actionsColumn: 'actions',           // text[] storage
      // OR actionColumn: 'action' for one row per action
      // resourceIdColumn defaults to the key ('workspaceId')
    },
    workbenchId: {
      name: 'workbench_grant',
      principalColumn: 'userId',
      actionsColumn: 'actions',
    },
  },

  // Polymorphic catch-all. Used when no per-resource entry matches.
  fallbackTable: {
    name: 'resource_grant',
    principalColumn: 'userId',
    resourceTypeColumn: 'resourceType',
    resourceIdColumn: 'resourceId',
    actionsColumn: 'actions',
    // Required: scope-column → resourceType-label map. Tells the compiler
    // which value to write into `resourceType` for a given hasGrant call.
    scopeColumnTypeMap: {
      tenantId: 'Tenant',
      orgId: 'Org',
    },
  },

  // Principal claim used in `WHERE principalColumn = <claim>::uuid`.
  principalClaim: 'sub', // default
})
```

The emitter dispatches `p.hasGrant('action', col('scopeColumn'))` as:
1. Explicit `ctx.compileHasGrant` override (if present) — always wins.
2. `ctx.resourceGrants.tables[scopeColumn]` — per-resource override.
3. `ctx.resourceGrants.fallbackTable` + `scopeColumnTypeMap[scopeColumn]` — polymorphic.
4. **Throw at compile time** with an actionable error pointing at the missing config — better than emitting broken SQL.

Generated SQL for the per-resource path (`actionsColumn` form):

```sql
EXISTS (
  SELECT 1 FROM workspace_grant
  WHERE "userId" = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid
    AND "workspaceId" = "<row>.workspaceId"
    AND 'edit' = ANY(actions)
)
```

For the polymorphic path:

```sql
EXISTS (
  SELECT 1 FROM resource_grant
  WHERE "userId" = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid
    AND "resourceId" = "<row>.tenantId"
    AND "resourceType" = 'Tenant'
    AND 'edit' = ANY(actions)
)
```

## Consequences

**Positive**

- Unblocks consumers (Flowchestra) whose authz model already lives in tables.
- `p.hasGrant(...)` works without any consumer-side `compileHasGrant` override — pure declarative authoring across both source modes.
- Per-resource + polymorphic composition matches real-world heterogeneous shapes; users don't have to pick one paradigm.
- Compile-time errors when config is missing or inconsistent prevent silent "always denies" runtime bugs.
- Backward-compatible at the type level for `source: 'claims'`: existing consumers see no behavior change.

**Negative**

- `defineResourceGrants`'s discriminated return type means any code that read `.claimPath` unconditionally must now narrow (`if (rg.source === 'claims') { ... }`). We're in `0.1.0-alpha.x`; minor versions are allowed to break. Caught by type-check.
- Polymorphic dispatch requires explicit `scopeColumnTypeMap` — auto-deriving the resource type from `defineResources` would be more ergonomic but adds plumbing complexity and an implicit-magic dimension we prefer to avoid until we have user pain.
- The principal column is UUID-typed by the built-in compiler. Non-UUID principals (integer IDs, etc.) require an explicit `compileHasGrant` override. Documented; not a common case.
- Both grant tables (per-resource + polymorphic) need their own SELECT policy and GRANT in the consumer setup — guarddog doesn't emit policies for the grant tables themselves. (A future enhancement could; for alpha.2 we leave it to the consumer.)

## Alternatives considered

- **Per-resource only.** Simpler API, but Flowchestra has both shapes; we'd force them to choose one or maintain a parallel system. Rejected.
- **Polymorphic only.** Higher cardinality on the polymorphic table; loses per-resource indexability and clean per-table RLS. Rejected.
- **`compileHasGrant` override is enough — no declarative table source.** Possible today, but pushes every consumer to write the SQL emit logic. Defeats the declarative-DSL premise of guarddog. Rejected.
- **Auto-derive `resourceType` label from `defineResources`** (find the resource whose `parent.column` matches the scope column). Less config for the polymorphic path, but introduces magic that's hard to debug when the inference is wrong. Deferred — explicit `scopeColumnTypeMap` ships first; we can add a derivation pass later if request volume warrants it.
- **Action storage: pick one** (always `text[]` or always single-row). Both shapes exist in the wild; forcing one would push consumers to refactor their tables before they could adopt. Rejected — both supported, mutually exclusive per entry.

## References

- [ADR-0019 — Three permission layers + per-resource jsonb permissions](./0019-three-permission-layers-and-resource-permissions.md) — defines `resourceGrants` as the third layer.
- [`packages/core/src/resource-grants.ts`](../../packages/core/src/resource-grants.ts) — `defineResourceGrants` declaration + validation.
- [`packages/emitter-postgres-rls/src/compile-expr.ts`](../../packages/emitter-postgres-rls/src/compile-expr.ts) — `defaultCompileHasGrantTable` implementation.
- [`packages/cli/src/grant-table.e2e.test.ts`](../../packages/cli/src/grant-table.e2e.test.ts) — real-Postgres E2E covering both dispatch paths.
