# @prisma-guarddog/core

The DSL, AST, and compile pipeline. Every other package depends on this one.

## What lives here

- **DSL primitives** — `defineClaims`, `defineDbRoles`, `defineAppRoles`, `defineResources`, `defineResourceGrants`, `defineSchema`, `materializeSchema`.
- **Builders** — `Guarddog`, `ModelBuilder`, `PolicyBuilder`, `PolymorphicBuilder`, plus the fluent predicate API (`col`, `FluentExpr`, `PredicateBuilder`).
- **AST types** — `Expr`, `PolicyAst`, `PolymorphicAst`, `ColumnPrivilegeAst`, `NoPolicyAst`.
- **Op pipeline** — `compileToOps`, `compileToState`, `applyOps`, `diffStates`, `empty`. Producing a deterministic, intent-level `Op[]` is what makes the sidecar replay model work.
- **Naming** — `defaultTableResolver`, `policyName`, `snakeCase` (shared between core and the emitters so policy names stay consistent across the layers).

## Install

```sh
pnpm add @prisma-guarddog/core
# or, if you only need the CLI surface:
pnpm add prisma-guarddog
```

## 30-second usage

```ts
import {
  col,
  defineAppRoles,
  defineClaims,
  defineDbRoles,
  defineResources,
  defineSchema,
} from '@prisma-guarddog/core'

export default defineSchema({
  claims: defineClaims({
    accessor: 'request.jwt.claims',
    shape: (c) => ({ sub: c.uuid(), tenantId: c.uuid() }),
  }),
  dbRoles: defineDbRoles({
    app_user: { inherits: [], nologin: true },
    app_system: { inherits: ['app_user'], bypassesRls: true, nologin: true },
  }),
  appRoles: defineAppRoles({ 'workspace.admin': {} }),
  resources: defineResources({
    Tenant: { model: 'Tenant', id: 'id', children: ['Workspace'] },
    Workspace: {
      model: 'Workspace',
      id: 'id',
      parent: { resource: 'Tenant', column: 'tenantId' },
    },
  }),

  policies(guard) {
    guard
      .model('Workspace')
      .policy('app_user')
      .select((p) => p.claim('tenantId').eq(col('tenantId')))
  },
})
```

`guarddog migrate` reads a file shaped like this and emits the migration.

## Where to read next

- [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) — how core fits with the emitters and CLI
- [`docs/GLOSSARY.md`](../../docs/GLOSSARY.md) — vocabulary (three permission layers, scope cascade)
- [`docs/adr/0018-schema-file-as-primary-interface.md`](../../docs/adr/0018-schema-file-as-primary-interface.md) — the schema-file positioning
- [`docs/adr/0019-three-permission-layers-and-resource-permissions.md`](../../docs/adr/0019-three-permission-layers-and-resource-permissions.md) — the layer split

## Stability

Pre-1.0. The DSL surface is stable; the `Op` shape may grow new variants before 1.0.
