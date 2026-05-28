---
'@flowchestra/prisma-guarddog-core': minor
'@flowchestra/prisma-guarddog-emitter-postgres-rls': minor
'@flowchestra/prisma-guarddog': minor
---

Grant-table extensions + override ergonomics, from the Flowchestra pilot (issues #5–#9).

**Rank-based grants** (#5, [ADR-0022](../docs/adr/0022-rank-based-grant-tables.md)) — a third action shape on `tables` / `fallbackTable` alongside `actionsColumn` / `actionColumn`:

```ts
tables: {
  workspaceId: {
    name: 'workspace_grants',
    principalColumn: 'user_id',
    roleColumn: 'role',
    roleHierarchy: ['READER', 'EDITOR', 'MANAGER', 'OWNER'],
    roleColumnType: '"ResourceRole"', // optional enum cast
  },
}
```

`p.hasGrant('EDITOR', col('workspaceId'))` compiles to `role = ANY(ARRAY['EDITOR','MANAGER','OWNER']::"ResourceRole"[])` — "at least rank EDITOR".

**Principal disjunction** (#6, [ADR-0023](../docs/adr/0023-grant-principal-disjunction.md)) — grants that match by user OR group:

```ts
{
  principalUserColumn: 'user_id',
  principalGroupColumn: 'group_id',
  groupMemberTable: { name: 'org_group_members', userColumn: 'user_id', groupColumn: 'group_id' },
}
```

emits `(user_id = <principal> OR group_id IN (SELECT group_id FROM org_group_members WHERE user_id = <principal>))`. `principalColumn` remains a backward-compatible alias for `principalUserColumn`. Rank and disjunction compose on the same table.

**`principalClaim` on `source: 'claims'`** (#7) — both `ResourceGrantsDefinition` variants now carry `principalClaim` (default `'sub'`), so `compileHasGrant` overrides read it from `ctx` instead of hardcoding.

**CLI-threaded render overrides** (#8, [ADR-0024](../docs/adr/0024-config-threaded-render-overrides.md)) — `guarddog.config.ts` accepts `renderOverrides` (the four compiler functions); `guarddog migrate` / `diff` / `emit` thread them into `renderOps`. Consumers with custom authz no longer reimplement the migrate pipeline.

**Re-exported compiler types** (#9) — `HasGrantCompiler`, `HasAppRoleCompiler`, `HasResourcePermissionCompiler`, `IsOwnerCompiler`, and the new `RenderOverrides` are exported from `@flowchestra/prisma-guarddog`.

**Breaking (minor, alpha line):** `ResourceGrantsDefinition`'s claims variant now requires `principalClaim` post-construction; code constructing the type by hand (rather than via `defineResourceGrants`) must add it. Caught by `tsgo`.
