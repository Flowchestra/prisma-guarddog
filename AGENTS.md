# AGENTS.md

This file is read by Cursor, Codex, and other AI coding agents that don't read `CLAUDE.md`.

## What this repo is

`prisma-guarddog` is a **schema-driven policy compiler for Prisma-backed Postgres applications**. The user maintains a TypeScript schema file (conventionally `prisma/guarddog.ts`, adjacent to `prisma/schema.prisma`). The CLI (or Prisma generator hook) reads that schema and produces idempotent SQL migrations covering: Postgres roles, RLS policies, column privileges, and per-resource permission infrastructure.

Mental model parallels Prisma's own: schema file in, autocomplete + linting via the TypeScript LSP, idempotent migrations out, applied through Prisma's standard migrate flow. See [ADR-0018](./docs/adr/0018-schema-file-as-primary-interface.md).

The three permission layers we model:

1. **`dbRoles`** — Postgres roles (`CREATE ROLE` + membership graph)
2. **`appRoles`** — application-level role strings, resolved against the `roles` claim
3. **`resourceGrants`** — principal × action × resource records, resolved against a `grants` claim (Phase 1) or grants table (Phase 2+)

Plus per-resource jsonb permissions for denormalized app-defined access lists.

**It is NOT:**

- A runtime authorization framework
- A Prisma middleware / client extension
- A ZenStack clone
- A generic FGA platform
- A library called imperatively (the `Guarddog` class is a runtime detail; consumers think in terms of the schema file)

For the full architectural framing, decision log, and roadmap, read in order:

1. [docs/README.md](./docs/README.md) — documentation map
2. [docs/PLAN.md](./docs/PLAN.md) — phased roadmap
3. [docs/GLOSSARY.md](./docs/GLOSSARY.md) — vocabulary (never collapse these terms)
4. [docs/adr/](./docs/adr/) — architecture decision records

## Repo layout (Turborepo)

This is a Turborepo monorepo. Source code lives in `packages/*`, each published independently to npm under the `@prisma-guarddog/*` scope. The unscoped `prisma-guarddog` CLI is the user-facing entrypoint.

See [ADR-0016](./docs/adr/0016-turborepo-monorepo.md) for the package split rationale.

## Toolchain

- **Package manager:** pnpm 10 (workspaces + Turborepo)
- **Node:** 22.18.0 (see `.nvmrc`)
- **TypeScript:** `tsgo --noEmit` for type checking (Microsoft's Go-based TS compiler, not `tsc`)
- **Lint:** `oxlint` only (no ESLint)
- **Format:** `oxfmt` for code; Prettier for `.json` / `.md` / `.yaml` via `lint-staged`
- **Tests:** vitest, against a real Postgres instance (see [ADR-0013](./docs/adr/0013-real-postgres-required-for-tests.md))
- **Commits:** Conventional Commits (commitlint enforced via husky); scope must be in the allowlist in `commitlint.config.js`

## How to contribute

1. Read the relevant ADRs before proposing architectural changes.
2. Every new Prisma model in a consumer's policies must have `.policy()`, `.noPolicy()`, or `importedRawPolicy()` — enforced by `@prisma-guarddog/lint`.
3. All emitted DDL must be idempotent (see [ADR-0008](./docs/adr/0008-idempotent-ddl-emission.md)).
4. All emitted DDL must be self-contained — nothing the consumer has to maintain by hand sits between the schema file and a working database.
5. User-facing example code should use the schema file form (`defineSchema({...})` → default export), not raw `new Guarddog({...})` ([ADR-0018](./docs/adr/0018-schema-file-as-primary-interface.md)).
6. Never propose runtime enforcement, Prisma middleware, or a non-TypeScript DSL.

## Learned preferences

- Verify each finding against the current code before proposing a fix.
- Don't be over-eager with edits; answer the question when that's what the user wants.
- Prefer barrel imports from `@prisma-guarddog/*` packages over deep file paths.
