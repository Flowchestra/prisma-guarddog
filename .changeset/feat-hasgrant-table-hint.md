---
'@flowchestra/prisma-guarddog-core': minor
'@flowchestra/prisma-guarddog-emitter-postgres-rls': minor
---

`hasGrant` per-call table hint (issue #11, [ADR-0025](../docs/adr/0025-hasgrant-per-call-table-hint.md)).

`p.hasGrant(action, scopeColumn, { table })` routes to an explicit `tables`-map key, disambiguating two policies that check the same scope column against different grant tables — the own-row case where both Workspace and Workbench policies use `col('id')`:

```ts
guard.model('Workspace').policy('app_user')
  .select((p) => p.hasGrant('READER', col('id'), { table: 'workspaceId' }))   // → workspace_grants
guard.model('Workbench').policy('app_user')
  .select((p) => p.hasGrant('READER', col('id'), { table: 'workbenchId' }))   // → workbench_grants
```

Omitting `opts.table` preserves the existing scope-column-name routing exactly — fully backward compatible. An unknown hint throws at compile time, listing the declared keys. The hint routes to `tables` only (not `fallbackTable`).

`opts.table` is currently a validated `string`; type-safe autocomplete on the key is a tracked alpha.5 follow-up (it requires a DSL-wide generics thread, decoupled so the behavior ships now without the inference risk).
