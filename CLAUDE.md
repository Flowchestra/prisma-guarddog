# CLAUDE.md

Project-specific instructions for Claude Code sessions in this repo.

## What this repo is — and is NOT

`prisma-guarddog` is a **TypeScript policy compiler and verification harness** for Prisma-backed Postgres applications. It emits Postgres RLS DDL, role grants, column privileges, sidecar migration metadata, and test scaffolds.

It is **NOT**:

- A runtime authorization framework
- A Prisma middleware / client extension
- A ZenStack clone
- A generic FGA platform
- A Go/Rust binary (see [ADR-0017](./docs/adr/0017-typescript-implementation.md))

When the user discusses RLS, policy authoring, column-level visibility, polymorphic grants, or FGAC, frame against this package. Never propose ZenStack, Yates, runtime middleware, magic predicate inference, or switching the language.

## Four primitives, never conflated

Same word "hierarchy" in casual speech, different animal in code. Conflating these is a footgun.

1. **`dbRoles`** — Postgres roles (`app_user`, `app_system`). DB-role inheritance: `app_system` inherits `app_user`.
2. **`businessRoles`** — application roles (`workspace.admin`, `workbench.editor`, `org.viewer`).
3. **`resources`** — resource tree (Tenant → Org → Workspace → Workbench). Resource-scope grant cascade.
4. **`grants`** — principal/action/resource records.

These do NOT share an abstraction. See [ADR-0003](./docs/adr/0003-four-primitive-split.md).

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

## Do NOT propose

- ZenStack, Yates, or any generic policy framework
- Runtime authorization middleware
- A separate DSL (HCL/YAML/ZModel-style) — the DSL **is** TypeScript ([ADR-0015](./docs/adr/0015-typescript-as-dsl.md))
- Rewriting in Go or Rust as a binary ([ADR-0017](./docs/adr/0017-typescript-implementation.md))
- Magic `USING`/`WITH CHECK` inference
- A central manifest file or schema snapshot
- Reverse-engineering business intent from imported SQL ([ADR-0012](./docs/adr/0012-scaffold-only-importer.md))
- pg-mem / pglite shims for testing — real Postgres only ([ADR-0013](./docs/adr/0013-real-postgres-required-for-tests.md))

## Toolchain

- pnpm 10, Node 22.18.0, Turborepo
- TypeScript via `tsgo --noEmit` (NOT `tsc`)
- `oxlint` (no ESLint), `oxfmt` for code, Prettier for `.json`/`.md`/`.yaml`
- vitest against real Postgres
- Conventional Commits; scopes restricted by `commitlint.config.js`

## When in doubt

1. Read the relevant ADR before proposing structural changes.
2. Confirm whether the question is about `columnPrivileges` (Phase 1) or row-conditional masking (Phase 2) before answering column-level visibility questions.
3. Confirm whether "hierarchy" means dbRole inheritance or resource-scope cascade before answering grant questions.
4. The Prisma schema is the source of truth for model definitions. The migration history (via sidecars) is the source of truth for currently-deployed policies. There is no third source of truth.
