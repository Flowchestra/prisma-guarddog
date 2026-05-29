---
'@flowchestra/prisma-guarddog-core': minor
'@flowchestra/prisma-guarddog-importer-prisma': minor
---

Typed `model()` + new `p.col()` autocomplete (ADR-0028). Model names and column references are now type-checked against your Prisma schema, sourced from DMMF — typos become compile errors instead of apply-time Postgres errors.

The Prisma generator now emits a `ModelColumns` const (model → SQL columns, from DMMF `dbName`, relations excluded) alongside `Models`/`ModelTables`. Pass it to `defineSchema` and the model + column unions are **inferred** (no explicit generic):

```ts
import { ModelColumns } from './generated/guarddog-models'

export default defineSchema({
  models: ModelColumns,
  // ...
  policies(guard) {
    guard.model('Workspace')          // ← autocompletes model names; typo = type error
      .policy('app_user')
      .select((p) => p.col('tenantId').eq(p.claim('tenantId')))  // ← p.col autocompletes Workspace's columns
  },
})
```

- **`p.col(name)`** — model-scoped, typed column reference; returns a `FluentExpr` (drop-in: `p.col('x').eq(…)`, `p.hasGrant('read', p.col('workspaceId'))`). The standalone `col(...)` stays as the untyped escape hatch for dynamic/raw column names.
- **`guard.model(name)`** and polymorphic `target(value, { model })` are typed against the model-name union.
- Columns use the SQL `dbName` (post-`@map`/`@@map`) — correct for a SQL policy tool.
- Fully backward compatible: omit `models` and `model()` / `p.col()` stay unconstrained (`string`); purely additive at runtime.
