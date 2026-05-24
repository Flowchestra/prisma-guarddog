---
'@flowchestra/prisma-guarddog-core': minor
'@flowchestra/prisma-guarddog-emitter-postgres-rls': minor
---

Add `source: 'table'` to `defineResourceGrants` (pulled forward from Phase 2).

Previously `defineResourceGrants` only supported `source: 'claims'` — grants encoded as a JSONB blob in the session JWT. Now consumers who store grants in Postgres tables can author policies natively:

```ts
defineResourceGrants({
  source: 'table',
  actions: ['edit', 'admin'] as const,

  // Per-scope-column overrides. The call `p.hasGrant('edit', col('workspaceId'))`
  // looks up `tables['workspaceId']` and emits EXISTS against that table.
  tables: {
    workspaceId: {
      name: 'workspace_grant',
      principalColumn: 'userId',
      actionsColumn: 'actions', // text[]
      // OR actionColumn: 'action' for one row per action
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
    scopeColumnTypeMap: { tenantId: 'Tenant', orgId: 'Org' },
  },

  principalClaim: 'sub', // default
})
```

**New exports**

- `@flowchestra/prisma-guarddog-core`: `PerResourceGrantTable`, `PolymorphicGrantTable` types.
- `@flowchestra/prisma-guarddog-emitter-postgres-rls`: `defaultCompileHasGrantTable` — the built-in compiler used when `source: 'table'`.

**Dispatch order** for `p.hasGrant('action', col('scopeColumn'))`:
1. Explicit `ctx.compileHasGrant` override (when set) — always wins.
2. `tables[scopeColumn]` — per-resource override.
3. `fallbackTable` + `scopeColumnTypeMap[scopeColumn]` — polymorphic.
4. Throw at compile time with an actionable error (no silent always-denies bugs).

**Breaking change** (minor — we're in `0.1.x` alpha): `ResourceGrantsDefinition` is now a discriminated union by `source`. Code that read `.claimPath` unconditionally must narrow: `if (rg.source === 'claims') { ... }`. Caught by `tsgo`.

See [ADR-0021](../docs/adr/0021-table-backed-resource-grants.md) for the full design rationale.
