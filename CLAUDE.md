# CLAUDE.md

Project-specific instructions for Claude Code sessions in this repo.

## What this repo is — and is NOT

`prisma-guarddog` is a **schema-driven policy compiler for Prisma-backed Postgres applications**. The user maintains a TypeScript schema file (conventionally `prisma/guarddog.ts`) adjacent to their `prisma/schema.prisma`. The CLI (or a Prisma generator hook) reads that schema and produces idempotent SQL migrations covering: roles, RLS policies, column privileges, and per-resource permission infrastructure.

The mental model parallels Prisma's own: schema file in, autocomplete + linting via the TypeScript LSP, idempotent migrations out, applied through Prisma's standard migrate flow.

It is **NOT**:

- A runtime authorization framework
- A Prisma middleware / client extension
- A ZenStack clone
- A generic FGA platform
- A Go/Rust binary (see [ADR-0017](./docs/adr/0017-typescript-implementation.md))
- A library you call imperatively (the `Guarddog` class is a runtime implementation detail, not the consumer surface — see [ADR-0018](./docs/adr/0018-schema-file-as-primary-interface.md))

When the user discusses RLS, policy authoring, column-level visibility, polymorphic grants, or FGAC, frame against this package. Never propose ZenStack, Yates, runtime middleware, magic predicate inference, or switching the language.

## The three permission layers

`prisma-guarddog` models authorization as three distinct layers, each separately declared and separately referenceable in policy predicates. The fourth concept (`resources`) is a topology, not a permission layer.

1. **`dbRoles`** — Postgres roles (`app_user`, `app_system`). DB-role inheritance: `app_system` inherits `app_user`. Emitted as `CREATE ROLE` + role-membership GRANTs.
2. **`appRoles`** — application role names (`workspace.admin`, `workbench.editor`). Referenced via `p.hasAppRole(...)`. Resolved against the `roles` claim.
3. **`resourceGrants`** — principal × action × resource records. Referenced via `p.hasGrant(action, col)`. Resolved against a `grants` claim (Phase 1) or a grants table (Phase 2+).

Plus a fourth orthogonal mechanism:

- **Per-resource jsonb permissions** — a `permissions: jsonb` column on individual resources carrying app-defined access lists. Referenced via `p.hasResourcePermission(action, col)`. Lets denormalized access logic ride alongside row data.

And the topology primitive:

- **`resources`** — resource tree (Tenant → Org → Workspace → Workbench). Not a permission layer; declares parent/child relationships that other things cascade through.

Never conflate the layers. "Hierarchy" is one word, several animals: dbRole inheritance, appRole membership, resourceGrant scope, resource-tree cascade, jsonb-permission lookup all use different SQL and resolve at different stages. See [ADR-0003](./docs/adr/0003-four-primitive-split.md).

## Column visibility — hard split

- **`.columnPrivileges()`** — static Postgres column privileges per role (compiles to `GRANT`/`REVOKE` on columns). Role-based, **not** row-conditional. **Phase 1.**
- **`.masks()` / `.projection()`** — row-conditional field visibility. **Phase 2 only.**

When asked about column-level work, always ask explicitly which primitive applies. See [ADR-0004](./docs/adr/0004-column-privileges-vs-row-conditional-masking.md).

## Explicit USING and WITH CHECK

No magic inference on insert/update/delete. Magic inference is how you ship "works in dev, leaks in prod." See [ADR-0005](./docs/adr/0005-explicit-using-and-with-check.md).

## Migrations + state

- Generated migrations colocate with Prisma's at `prisma/migrations/<timestamp>_<name>/migration.sql`.
- Each is paired with a `guarddog.json` sidecar (ops log).
- Current state is derived by **forward-replaying sidecars in `_prisma_migrations` ledger order**. There is no separate state file anywhere.
- All emitted DDL is idempotent — policies via `DROP IF EXISTS` + `CREATE`; the rest is natively idempotent.

See [ADR-0006](./docs/adr/0006-sidecar-migration-metadata.md), [ADR-0007](./docs/adr/0007-forward-replay-state-derivation.md), [ADR-0008](./docs/adr/0008-idempotent-ddl-emission.md).

## Phase scope (LOCKED)

**Phase 1:** core + emitters (RLS + column privileges) + importers + testing-postgres + lint + Flowchestra preset + CLI. 5 proof tables in `examples/`.

**Phase 2:** FDW table support; `.masks()` / `.projection()` for row-conditional field visibility; Supabase-specific importer.

**Phase 3:** WorkOS FGA bridge.

**Out of scope entirely:** warehouse/datalake coverage; runtime enforcement; Prisma client extension.

See [ADR-0014](./docs/adr/0014-phase-scope-boundaries.md).

## The schema file convention

The user's primary interface is a **schema file** at `prisma/guarddog.ts` (or wherever `guarddog.config.ts` points). It `export default`s a value built by `defineSchema({...})`, consolidating claims, the three permission layers, resources, and a `policies(guard)` callback. The CLI auto-discovers it. See [ADR-0018](./docs/adr/0018-schema-file-as-primary-interface.md).

When proposing example code, default to the schema-file form — not raw `new Guarddog({...})`. Reserve the imperative form for cases where the user is clearly extending guarddog itself (testing harness internals, custom extensions).

## Self-contained emission

Emitted SQL **never** depends on consumer-written helpers, an `app.*` schema the consumer maintains, or library code the consumer installs. If guarddog declares it in the schema, guarddog emits the DDL to make it real. Past examples that got this wrong (and the fix):

- Scoped `hasRole` used to emit `app.has_role_on(...)` — refactored to inline claim-payload reads.
- dbRoles used to be assumed pre-existing — `emitRoles()` now generates `CREATE ROLE` + membership GRANTs.

The migration is the boundary. Anything between the schema file and a working database is guarddog's job to generate.

## Do NOT propose

- ZenStack, Yates, or any generic policy framework
- Runtime authorization middleware
- A separate DSL (HCL/YAML/ZModel-style) — the DSL **is** TypeScript ([ADR-0015](./docs/adr/0015-typescript-as-dsl.md))
- Rewriting in Go or Rust as a binary ([ADR-0017](./docs/adr/0017-typescript-implementation.md))
- Magic `USING`/`WITH CHECK` inference
- A central manifest file or schema snapshot
- Reverse-engineering business intent from imported SQL ([ADR-0012](./docs/adr/0012-scaffold-only-importer.md))
- pg-mem / pglite shims for testing — real Postgres only ([ADR-0013](./docs/adr/0013-real-postgres-required-for-tests.md))
- Requiring the consumer to hand-write any SQL guarddog could generate (helper functions, schemas, roles, grants tables — all guarddog's job)
- Imperative `new Guarddog({...})` examples in user-facing docs (schema file pattern is canonical — [ADR-0018](./docs/adr/0018-schema-file-as-primary-interface.md))

## Toolchain

- pnpm 10, Node 22.18.0, Turborepo
- TypeScript via `tsgo --noEmit` (NOT `tsc`)
- `oxlint` (no ESLint), `oxfmt` for code, Prettier for `.json`/`.md`/`.yaml`
- vitest against real Postgres
- Conventional Commits; scopes restricted by `commitlint.config.js`

## When in doubt

1. Read the relevant ADR before proposing structural changes.
2. Confirm whether the question is about `columnPrivileges` (Phase 1) or row-conditional masking (Phase 2) before answering column-level visibility questions.
3. Confirm which permission layer is in play (dbRole / appRole / resourceGrant / per-resource jsonb) before answering authorization questions — they have different APIs and different SQL output.
4. The Prisma schema (`schema.prisma`) is the source of truth for model definitions. The guarddog schema (`prisma/guarddog.ts`) is the source of truth for policies. The migration history (via sidecars) is the source of truth for currently-deployed state. There is no fourth source of truth.
