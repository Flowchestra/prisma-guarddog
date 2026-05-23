# prisma-guarddog

> A TypeScript policy compiler and verification harness for Prisma-backed Postgres applications.

`prisma-guarddog` lets you author Postgres Row-Level Security policies, role grants, and column privileges in TypeScript — typed against your generated Prisma client — and emits idempotent SQL migrations, sidecar metadata, and a test harness that verifies your policies against a real Postgres database.

It is a **policy compiler**, not a runtime authorization framework. All enforcement happens in Postgres. There is no Prisma client extension, no middleware, no app-layer WHERE injection.

## Why

Hand-rolling RLS across dozens or hundreds of tables — plus column privileges, polymorphic grants, and an evolving role graph — does not scale. Existing tools fall short:

- **ZenStack** enforces at the app layer, not at the DB.
- **Yates** is Prisma 4.x only, has no column-level security, no polymorphic relations, and no composable predicates.
- **Atlas** generates migrations but policies are still hand-written SQL (and the diff feature is Pro-tier).
- **Supabase declarative schemas** explicitly skip RLS and column privileges in `migra`.

`prisma-guarddog` exists to be the policy compiler in this space — TypeScript-native, Postgres-emitting, multi-package extensible.

See [docs/adr/0002-evaluated-and-rejected-alternatives.md](./docs/adr/0002-evaluated-and-rejected-alternatives.md) for the full evaluation.

## Status

**Phase 1 — pre-alpha.** API and scope locked; implementation in progress. Not yet published to npm.

## Roadmap

See [docs/PLAN.md](./docs/PLAN.md) for the full phased roadmap.

**Phase 1** (in progress): Core policy DSL, RLS + column-privilege emitters, Postgres + Prisma scaffold importers, real-Postgres test harness, lint extension, Flowchestra preset.

**Phase 2**: FDW table support, row-conditional field masking (`.masks()` / `.projection()`), Supabase-specific importer.

**Phase 3**: WorkOS FGA bridge (actions → composable roles → grant cascade).

## Documentation

- **[docs/README.md](./docs/README.md)** — documentation map
- **[docs/PLAN.md](./docs/PLAN.md)** — phased roadmap
- **[docs/GLOSSARY.md](./docs/GLOSSARY.md)** — vocabulary (four-primitive split)
- **[docs/adr/](./docs/adr/)** — architecture decision records

## License

[MIT](./LICENSE)
