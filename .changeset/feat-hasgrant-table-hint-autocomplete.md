---
'@flowchestra/prisma-guarddog-core': minor
---

Type-safe autocomplete for the `hasGrant` table hint (#12, follow-up to ADR-0025).

The `opts.table` hint added in alpha.4 was a plain `string`. It's now type-checked against the declared `tables` keys: valid keys autocomplete, typos are compile errors.

```ts
const guard = new Guarddog({
  // ...
  resourceGrants: defineResourceGrants({
    source: 'table',
    actions: ['READER', 'EDITOR'] as const,
    tables: {
      workspaceId: { name: 'workspace_grants', principalColumn: 'user_id', actionsColumn: 'actions' },
      workbenchId: { name: 'workbench_grants', principalColumn: 'user_id', actionsColumn: 'actions' },
    },
  }),
})

guard.model('Workspace').policy('app_user')
  .select((p) => p.hasGrant('READER', col('id'), { table: 'workspaceId' }))   // ✓ autocompletes
guard.model('Workbench').policy('app_user')
  .select((p) => p.hasGrant('READER', col('id'), { table: 'typo' }))          // ✗ type error
```

Implemented by threading a `TGrantTableKeys` generic (inferred from the `tables` map keys) from `defineResourceGrants` → `Guarddog` → `PredicateBuilder` and the builder hierarchy. Fully backward compatible: the generic defaults to `string`, so claims-source schemas, schemas without a table source, and any existing call site stay unconstrained (any-string hint accepted, no narrowing). Verified by `@ts-expect-error` type-level tests that only pass type-check when the narrowing is live.

Core-only change — the emitter and CLI reference `ResourceGrantsDefinition` without type arguments, so the new generic defaults there and they're unaffected.
