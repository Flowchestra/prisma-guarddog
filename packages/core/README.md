# @flowchestra/prisma-guarddog-core

The DSL, AST, and compile pipeline. Every other package depends on this one.

## What lives here

- **DSL primitives** — `defineClaims`, `defineDbRoles`, `defineAppRoles`, `defineResources`, `defineResourceGrants`, `defineFunctions`, `defineSchema`, `materializeSchema`.
- **Builders** — `Guarddog`, `ModelBuilder`, `PolicyBuilder`, `RestrictivePolicyBuilder`, `PolymorphicBuilder`, plus the fluent predicate API (`col`, `FluentExpr`, `PredicateBuilder`).
  - Permissive policies via `.policy(role).select / insert / update / delete`.
  - Restrictive isolation floors via `.isolation(fn)` (sugar) or `.restrictivePolicy(role).forAll(fn)` (low-level) — emit as `AS RESTRICTIVE FOR ALL`, AND'd with every permissive ([ADR-0032](../../docs/adr/0032-restrictive-policy-support.md)).
  - Legacy-name parity for atomic in-place cutovers via `.named(name)` and per-verb `{ name }` ([ADR-0031](../../docs/adr/0031-user-declared-policy-names.md)).
- **AST types** — `Expr`, `PolicyAst` (carries optional `restrictive` + `isolation`), `AllSpec`, `PolymorphicAst`, `ColumnPrivilegeAst`, `NoPolicyAst`.
- **Op pipeline** — `compileToOps`, `compileToState`, `applyOps`, `diffStates`, `empty`. Producing a deterministic, intent-level `Op[]` is what makes the sidecar replay model work. The duplicate-name guard rejects two policies sharing `(table, name)` at compile time.
- **Naming** — `defaultTableResolver`, `policyName`, `snakeCase` (shared between core and the emitters so policy names stay consistent across the layers).

## Install

```sh
pnpm add @flowchestra/prisma-guarddog-core
# or, if you only need the CLI surface:
pnpm add @flowchestra/prisma-guarddog
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
} from '@flowchestra/prisma-guarddog-core'

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

Pre-1.0; published under the `@flowchestra` scope on GitHub Packages, currently at `0.1.0-alpha.13`. The DSL surface for Phase 1 + Phase 1.5 is stable. The `Op` shape may grow new variants before 1.0 — additive only, no breaking-removals planned.
