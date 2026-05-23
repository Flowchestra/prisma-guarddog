# prisma-guarddog

> A schema-driven policy compiler for Prisma-backed Postgres applications.

`prisma-guarddog` lets you author Postgres RLS policies, role graphs, column privileges, and resource grants in a single TypeScript schema file — conventionally `prisma/guarddog.ts`, sibling to `schema.prisma`. The CLI (or a Prisma generator hook) reads that schema and produces idempotent SQL migrations that drop into `prisma/migrations/` alongside Prisma's own.

The mental model parallels Prisma's: schema file in, autocomplete + linting via the TypeScript LSP, idempotent migrations out, applied via Prisma's standard `migrate` flow. The runtime is invisible to the consumer; the schema file is the value-prop.

It is a **policy compiler**, not a runtime authorization framework. All enforcement happens in Postgres. There is no Prisma client extension, no middleware, no app-layer WHERE injection.

## What you get

```ts
// prisma/guarddog.ts
import { defineSchema } from 'prisma-guarddog'

export default defineSchema({
  claims: { /* JWT shape */ },
  dbRoles: { /* Postgres roles + inheritance */ },
  appRoles: { /* application role vocabulary */ },
  resourceGrants: { /* principal × action × resource */ },
  resources: { /* Tenant → Org → Workspace → Workbench tree */ },

  policies(guard) {
    guard.model('Workbench').policy('app_user')
      .select((p) => p.hasAppRole('workspace.viewer'))
      .insert({ check: (p) => p.hasGrant('write', col('workspaceId')) })
    // ...
  },
})
```

Then:

```sh
prisma-guarddog migrate --name initial-policies
# emits prisma/migrations/<timestamp>_initial-policies/migration.sql
# emits prisma/migrations/<timestamp>_initial-policies/guarddog.json (provenance)
```

`prisma migrate deploy` applies it like any other migration. The migration is **fully self-contained** — no helper functions, no `app.*` schema, no consumer-side SQL between the schema file and a working database.

## Why

Hand-rolling RLS across dozens or hundreds of tables — plus column privileges, polymorphic grants, and an evolving role graph — does not scale. Existing tools fall short:

- **ZenStack** enforces at the app layer, not at the DB.
- **Yates** is Prisma 4.x only, has no column-level security, no polymorphic relations, and no composable predicates.
- **Atlas** generates migrations but policies are still hand-written SQL (and the diff feature is Pro-tier).
- **Supabase declarative schemas** explicitly skip RLS and column privileges in `migra`.

`prisma-guarddog` exists to be the policy compiler in this space — schema-driven, TypeScript-native, Postgres-emitting, multi-package extensible.

See [docs/adr/0002-evaluated-and-rejected-alternatives.md](./docs/adr/0002-evaluated-and-rejected-alternatives.md) for the full evaluation.

## Status

**Phase 1 — pre-alpha.** API and scope locked; implementation in progress. Not yet published to npm.

## Roadmap

See [docs/PLAN.md](./docs/PLAN.md) for the full phased roadmap.

**Phase 1** (in progress): Schema file DSL, three-layer permission model (dbRoles / appRoles / resourceGrants), per-resource jsonb permissions, RLS + role + column-privilege emitters, Prisma DMMF integration, real-Postgres test harness, lint extension, Flowchestra preset, CLI.

**Phase 2**: FDW table support, row-conditional field masking (`.masks()` / `.projection()`), Supabase-specific importer, table-backed `resourceGrants` source.

**Phase 3**: WorkOS FGA bridge (actions → composable roles → grant cascade).

## Documentation

- **[docs/README.md](./docs/README.md)** — documentation map
- **[docs/PLAN.md](./docs/PLAN.md)** — phased roadmap
- **[docs/GLOSSARY.md](./docs/GLOSSARY.md)** — vocabulary (three permission layers + topology)
- **[docs/adr/](./docs/adr/)** — architecture decision records
- **[docs/adr/0018-schema-file-as-primary-interface.md](./docs/adr/0018-schema-file-as-primary-interface.md)** — the core positioning decision

## License

[MIT](./LICENSE)
