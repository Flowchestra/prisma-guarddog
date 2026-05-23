# prisma-guarddog

> A schema-driven policy compiler for Prisma-backed Postgres applications.

`prisma-guarddog` lets you author Postgres RLS policies, role graphs, column privileges, and resource grants in a single TypeScript schema file — conventionally `prisma/guarddog.ts`, sibling to `schema.prisma`. The CLI reads that schema, diffs it against your previous migrations, and writes a fresh `prisma/migrations/<timestamp>_<slug>/` containing idempotent SQL plus a typed sidecar. `prisma migrate` applies it like any other migration.

The mental model parallels Prisma's: schema file in, autocomplete + linting via the TypeScript LSP, idempotent migrations out, applied via Prisma's standard `migrate` flow. The runtime is invisible to the consumer; the schema file is the value-prop.

It is a **policy compiler**, not a runtime authorization framework. All enforcement happens in Postgres. There is no Prisma client extension, no middleware, no app-layer WHERE injection. See [ADR-0001](./docs/adr/0001-policy-compiler-not-runtime-middleware.md).

## What you get

```ts
// prisma/guarddog.ts
import {
  col,
  defineAppRoles,
  defineClaims,
  defineDbRoles,
  defineResources,
  defineSchema,
} from 'prisma-guarddog'

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
      .insert({
        check: (p) => p.claim('tenantId').eq(col('tenantId')).and(p.hasAppRole('tenant.admin')),
      })
  },
})
```

Then:

```sh
guarddog migrate --slug initial-policies
# writes prisma/migrations/<timestamp>_initial-policies/migration.sql
#        prisma/migrations/<timestamp>_initial-policies/guarddog.json
prisma migrate deploy
```

The migration is fully self-contained — no helper functions, no `app.*` schema, no consumer-side SQL between the schema file and a working database.

## Quickstart

Packages publish to **GitHub Packages** under the `@flowchestra` scope. Two `.npmrc` lines are required — typically in your repo or `~/.npmrc`:

```ini
@flowchestra:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

`GITHUB_TOKEN` needs `read:packages` scope. Then:

```sh
pnpm add -D @flowchestra/prisma-guarddog
```

Add the generator block to your Prisma schema:

```prisma
generator guarddog {
  provider = "prisma-guarddog-generator"
}
```

Create `prisma/guarddog.ts` and `export default defineSchema({...})`. See [`examples/flowchestra`](./examples/flowchestra) for a complete realistic schema.

Releases are driven by Changesets; the publish process lives in [`RELEASING.md`](./RELEASING.md).

## Architecture

Nine packages plus an example, all in this workspace:

<!-- markdownlint-disable MD060 -->

| Package | Purpose |
| --- | --- |
| [`@flowchestra/prisma-guarddog-core`](./packages/core/README.md) | DSL primitives, AST, Op union, compile + diff |
| [`@flowchestra/prisma-guarddog-emitter-postgres-rls`](./packages/emitter-postgres-rls/README.md) | `Expr` → SQL; `PolicyAst` → CREATE POLICY; role lifecycle |
| [`@flowchestra/prisma-guarddog-emitter-postgres-column-privileges`](./packages/emitter-postgres-column-privileges/README.md) | `ColumnPrivilegeAst` → GRANT/REVOKE |
| [`prisma-guarddog`](./packages/cli/README.md) (CLI) | `migrate`, `check`, generator binary, `renderOps`, sidecar I/O |
| [`@flowchestra/prisma-guarddog-importer-prisma`](./packages/importer-prisma/README.md) | Prisma DMMF readers + model-type codegen |
| [`@flowchestra/prisma-guarddog-importer-postgres`](./packages/importer-postgres/README.md) | `pg_policies` → scaffold (`rawSql()` + `.todo()`) |
| [`@flowchestra/prisma-guarddog-testing-postgres`](./packages/testing-postgres/README.md) | `withScenario` + assertion helpers (real-PG only) |
| [`@flowchestra/prisma-guarddog-lint`](./packages/lint/README.md) | Coverage check |
| [`@flowchestra/prisma-guarddog-preset`](./packages/preset-flowchestra/README.md) | Opinionated preset (reference for downstream presets) |

<!-- markdownlint-enable MD060 -->

End-to-end compile path, package interaction diagram, and the Op-union rationale all live in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md). Read that first.

## Why

Hand-rolling RLS across dozens or hundreds of tables — plus column privileges, polymorphic grants, and an evolving role graph — does not scale. Existing tools fall short:

- **ZenStack** enforces at the app layer, not at the DB.
- **Yates** is Prisma 4.x only, has no column-level security, no polymorphic relations, and no composable predicates.
- **Atlas** generates migrations but policies are still hand-written SQL (and the diff feature is Pro-tier).
- **Supabase declarative schemas** explicitly skip RLS and column privileges in `migra`.

`prisma-guarddog` exists to be the policy compiler in this space — schema-driven, TypeScript-native, Postgres-emitting, multi-package extensible.

See [docs/adr/0002-evaluated-and-rejected-alternatives.md](./docs/adr/0002-evaluated-and-rejected-alternatives.md) for the full evaluation.

## Status

**Phase 1 implementation complete.** 374 unit tests pass across the workspace; the example schema in `examples/flowchestra` exercises the full compile + render path with deterministic SQL output.

**Pre-release.** Not yet published to npm.

### What's verified vs. what's not

| Verified | Not yet verified |
| --- | --- |
| DSL, compile pipeline, diff, render, sidecar replay (374 unit tests) | Real-Postgres semantic enforcement (E2E gated behind `GUARDDOG_E2E=1`) |
| `planMigrate` produces correct ops + SQL | `runMigrate` file-writing path (deferred pending built `dist/`) |
| Per-package type-check + lint clean | `pnpm -r run build` end-to-end |
| `loadSchema`'s validate + materialize helpers | The jiti-from-disk path (same `dist/` constraint) |
| Coverage lint + flowchestra preset | CI workflow (`.github/workflows/` not yet authored) |

See [`docs/PLAN.md`](./docs/PLAN.md) for the full phased roadmap and definition of done.

## Roadmap

- **Phase 2** — FDW table support, row-conditional field masking (`.masks()` / `.projection()`), Supabase-specific importer, table-backed `resourceGrants` source.
- **Phase 3** — WorkOS FGA bridge (actions → composable roles → grant cascade).

## Documentation

- **[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)** — system overview, package map, end-to-end compile path *(start here)*
- **[`docs/README.md`](./docs/README.md)** — documentation hub: per-package links, ADRs by category
- **[`docs/PLAN.md`](./docs/PLAN.md)** — phased roadmap
- **[`docs/GLOSSARY.md`](./docs/GLOSSARY.md)** — vocabulary (three permission layers, scope cascade)
- **[`docs/adr/`](./docs/adr/)** — 19 architecture decision records
- **[`examples/`](./examples/README.md)** — working end-to-end examples

## License

[MIT](./LICENSE)
