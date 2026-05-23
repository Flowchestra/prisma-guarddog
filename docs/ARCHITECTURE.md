# Architecture

`prisma-guarddog` is a schema-driven Postgres policy compiler. The runtime is invisible to consumers: a TypeScript schema file goes in, idempotent SQL migrations come out, and Prisma's `migrate` runner applies them. Everything between those endpoints is a small graph of pure-function packages.

## Package map

```
                ┌─────────────────────────────────────────────────────────────┐
                │                  @flowchestra/prisma-guarddog-core                       │
                │  defineSchema · defineClaims · defineDbRoles ·               │
                │  defineAppRoles · defineResources · defineResourceGrants     │
                │  Guarddog · compileToOps · diffStates · applyOps             │
                └─────────────────────────────────────────────────────────────┘
                  ▲              ▲                ▲              ▲
                  │ AST          │ Op[]           │ AST          │ Guarddog
                  │              │                │              │
   ┌──────────────┴────┐ ┌───────┴────────┐ ┌─────┴──────┐ ┌─────┴────────┐
   │ emitter-postgres- │ │ prisma-guarddog│ │ importer-  │ │     lint     │
   │       rls         │ │   (cli)        │ │  postgres  │ │              │
   │ CREATE POLICY     │ │ migrate, check │ │ pg_policies│ │ coverage     │
   │ enable/force RLS  │ │ planMigrate    │ │  → scaffold│ │ check        │
   │ role DDL          │ │ renderOps      │ │            │ │              │
   └───────────────────┘ └────┬───────────┘ └────────────┘ └──────────────┘
   ┌───────────────────┐      │                ┌─────────────────────────┐
   │ emitter-postgres- │      │                │     importer-prisma     │
   │ column-privileges │      │                │   DMMF → model types,   │
   │ GRANT/REVOKE      │      │                │   Prisma generator      │
   └───────────────────┘      │                │   binary handler        │
                              ▼                └─────────────────────────┘
                       ┌──────────────┐
                       │  prisma/     │
                       │  migrations/ │
                       │  <ts>_guard/ │
                       │   migration  │
                       │   .sql       │
                       │   guarddog   │
                       │   .json      │
                       └──────────────┘
                              ▲
                              │ forward replay on next migrate
                              │
            ┌─────────────────┴──────────────────┐
            │       @flowchestra/prisma-guarddog-            │
            │       preset-flowchestra           │
            │ createFlowchestraGuarddog()        │
            │ flowchestraClaims / DbRoles /      │
            │ AppRoles / Resources               │
            └────────────────────────────────────┘

  Verification (orthogonal to the compile path)
            ┌────────────────────────────────────┐
            │   @flowchestra/prisma-guarddog-testing-postgres │
            │ withScenario · assertAllowed /     │
            │ assertDenied / assertVisibleRows / │
            │ assertHiddenColumns                │
            └────────────────────────────────────┘
```

## The compile path, end-to-end

1. **Author** — a `prisma/guarddog.ts` file `export default`s a value from `defineSchema({...})`. Claims, dbRoles, appRoles, resources, and an optional resourceGrants are declared via the core primitives. The `policies(guard)` callback authors per-model policies, polymorphic targets, column privileges, and `noPolicy()` opt-outs.

2. **Materialize** — `materializeSchema(schemaDef)` (in core) turns the declarative value into a `Guarddog` instance. The CLI's `loadSchema` (via jiti) handles the file load; tests can call `materializeSchema` directly.

3. **Compile** — `compileToOps(guard)` walks the Guarddog into a deterministic `Op[]`. Each op is intent-level: `create-role`, `enable-rls`, `create-policy` (carrying the full `Expr` tree, not SQL), `grant-column`, etc. Polymorphic targets fuse their discriminator equality into `using`/`check` at this stage. See [`ADR-0007`](./adr/0007-forward-replay-state-derivation.md).

4. **Diff** — `applyOps(empty(), historicalOps)` forward-replays every `guarddog.json` sidecar found under the configured migrations directory to derive the current declared `State`. `diffStates(current, target)` produces the minimal `Op[]` to transform one into the other. Drops precede adds; roles outlive their dependents on the way down; on the way up RLS comes up before policies. Policy content drift is treated as drop+create.

5. **Render** — `renderOps(ops, { claims, resourceGrants })` (in the CLI) dispatches per-op kind to the emitter primitives. `create-policy` delegates to `compileExpr` from `emitter-postgres-rls` so polymorphic-discriminator fusion, claim-jsonb lookups, and resource-grant rewriting all share one implementation. Column ops render via the column-privileges emitter. Role lifecycle ops use `pg_roles`/`pg_auth_members`-guarded `DO` blocks.

6. **Persist** — `runMigrate` allocates `prisma/migrations/<YYYYMMDDHHMMSS>_<slug>/`, writes `migration.sql` (the rendered DDL) and `guarddog.json` (the original `Op[]` as a sidecar). Prisma's migration runner picks the SQL up alongside any Prisma-authored migrations.

7. **Verify** — `testing-postgres` exposes `withScenario(client, { role, claims }, fn)` plus assertion helpers. Each scenario opens a transaction, installs the test identity, runs assertions, rolls back. ADR-0013 hard-requires real Postgres — no `pg-mem`/`pglite` shims, because they don't implement enough of `SET ROLE`, `current_setting`, and column GRANTs to give honest signal.

## Where each package lives in that path

| Package | Path step | Role |
|---|---|---|
| [`@flowchestra/prisma-guarddog-core`](../packages/core) | 1–4 | DSL primitives, AST, Op union, compile + diff |
| [`@flowchestra/prisma-guarddog-emitter-postgres-rls`](../packages/emitter-postgres-rls) | 5 | `Expr` → SQL fragments; `PolicyAst` → idempotent CREATE POLICY |
| [`@flowchestra/prisma-guarddog-emitter-postgres-column-privileges`](../packages/emitter-postgres-column-privileges) | 5 | `ColumnPrivilegeAst` → GRANT/REVOKE |
| [`prisma-guarddog`](../packages/cli) (CLI) | 2, 5, 6 | jiti loader, `renderOps`, `migrate` / `check` subcommands, Prisma generator binary |
| [`@flowchestra/prisma-guarddog-importer-prisma`](../packages/importer-prisma) | side | Prisma DMMF readers + model-type codegen (autocomplete) |
| [`@flowchestra/prisma-guarddog-importer-postgres`](../packages/importer-postgres) | side | `pg_policies` → `rawSql() + .todo()` scaffold (ADR-0012) |
| [`@flowchestra/prisma-guarddog-testing-postgres`](../packages/testing-postgres) | 7 | `withScenario` + assertion helpers |
| [`@flowchestra/prisma-guarddog-lint`](../packages/lint) | side | Coverage check: every Prisma model has a policy / polymorphic / noPolicy |
| [`@flowchestra/prisma-guarddog-preset`](../packages/preset-flowchestra) | 1 | Opinionated preset (claims, roles, resources) — example of a downstream preset |

The dependency graph fans out from `core`. Every non-CLI package depends only on `core` (plus, in the emitter case, dialect-specific helpers). The CLI is the only package that depends on multiple emitter packages; this is intentional — `renderOps` is the dispatcher.

## The Op union: why intent, not SQL

`compileToOps` produces ops that carry the `Expr` tree, not pre-rendered SQL. The sidecar JSON written next to each migration captures that intent — so forward replay reconstructs the same declared `State` regardless of dialect, and a future emitter (e.g., a different RDBMS) can render the same ops differently.

This also means policy-content drift is exact: two policies with the same name but different `using` expressions compare unequal at the AST level, and the diff emits a clean drop+create pair rather than trying to `ALTER POLICY` (which Postgres only partially supports).

## Self-contained emission

The emitted SQL never depends on consumer-side helper functions or an `app.*` schema. Three-permission-layer predicates compile inline:

- `p.hasAppRole('workspace.admin')` → `(claims -> 'roles') ? 'workspace.admin'`
- `p.hasGrant('write', col('workspaceId'))` → `(claims -> 'grants' -> 'write') ? "workspaceId"::text`
- `p.hasResourcePermission('read', col('permissions'))` → `(permissions -> 'roles' -> '...') ? 'read'`

Role lifecycle wraps `CREATE ROLE` / `GRANT … TO …` in `pg_roles`/`pg_auth_members`-guarded DO blocks so the migration is idempotent on re-runs.

## What's out of scope

These are deliberate non-goals, not "later":

- **Runtime middleware / Prisma client extension** — see [ADR-0001](./adr/0001-policy-compiler-not-runtime-middleware.md). All enforcement happens in Postgres.
- **In-memory test shims** — see [ADR-0013](./adr/0013-real-postgres-required-for-tests.md).
- **A non-TypeScript DSL** — see [ADR-0015](./adr/0015-typescript-as-dsl.md).
- **A compiled Go/Rust binary** — see [ADR-0017](./adr/0017-typescript-implementation.md).
- **Warehouse / datalake coverage** — different access model.

## Further reading

- [`docs/PLAN.md`](./PLAN.md) — phased roadmap, definition of done
- [`docs/GLOSSARY.md`](./GLOSSARY.md) — vocabulary (three permission layers + topology terminology)
- [`docs/adr/`](./adr/) — 19 architecture decision records
- [`examples/flowchestra`](../examples/flowchestra) — five representative policies + opt-in real-Postgres E2E suite
