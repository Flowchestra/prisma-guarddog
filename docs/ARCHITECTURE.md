# Architecture

`prisma-guarddog` is a schema-driven Postgres policy compiler. The runtime is invisible to consumers: a TypeScript schema file goes in, idempotent SQL migrations come out, and Prisma's `migrate` runner applies them. Everything between those endpoints is a small graph of pure-function packages.

Two operating modes share that graph:

1. **Greenfield** — the compile path. Author → compile → diff → render → persist → verify.
2. **Brownfield** — the adoption path. Read live `pg_policies` → classify (managed / foreign / acknowledged / stale / restrictiveness-mismatch) → triage → fold into the schema → cut over.

## Package map

```text
                ┌─────────────────────────────────────────────────────────────┐
                │              @flowchestra/prisma-guarddog-core               │
                │  defineSchema · defineClaims · defineDbRoles · defineFunctions│
                │  defineAppRoles · defineResources · defineResourceGrants     │
                │  Guarddog · compileToOps · diffStates · applyOps             │
                └─────────────────────────────────────────────────────────────┘
                  ▲              ▲                ▲              ▲
                  │ AST          │ Op[]           │ AST          │ Guarddog
                  │              │                │              │
   ┌──────────────┴────┐ ┌───────┴────────┐ ┌─────┴──────┐ ┌─────┴────────┐
   │ emitter-postgres- │ │ prisma-guarddog│ │ importer-  │ │     lint     │
   │       rls         │ │     (CLI)      │ │  postgres  │ │              │
   │ CREATE POLICY     │ │ migrate, check │ │ pg_policies│ │ coverage     │
   │ AS RESTRICTIVE    │ │ drift, adopt   │ │  → scaffold│ │ WIP/declared │
   │ enable/force RLS  │ │ emit, diff,    │ │ inventory  │ │ name nudges  │
   │ role DDL          │ │ import         │ │ + drift in │ │              │
   └───────────────────┘ │ renderOps      │ │ via libpq  │ └──────────────┘
   ┌───────────────────┐ │ planMigrate    │ └────────────┘
   │ emitter-postgres- │ └────┬───────────┘
   │ column-privileges │      │                ┌─────────────────────────┐
   │ GRANT/REVOKE      │      │                │     importer-prisma     │
   └───────────────────┘      ▼                │   DMMF → model types,   │
                       ┌──────────────┐        │   Prisma generator bin  │
                       │  prisma/     │        └─────────────────────────┘
                       │  migrations/ │
                       │  <ts>_guard/ │              ┌────────────────────┐
                       │   migration  │              │   preset-flowchestra│
                       │   .sql       │              │  reference preset:  │
                       │   guarddog   │              │  claims/roles/      │
                       │   .json      │              │  resources packaged │
                       └──────────────┘              └────────────────────┘
                              ▲
                              │ forward replay on next migrate
                              │
            ┌─────────────────┴──────────────────┐
            │       testing-postgres             │
            │ withScenario · assertAllowed /     │
            │ assertDenied / assertVisibleRows / │
            │ assertHiddenColumns                │
            └────────────────────────────────────┘
```

## The greenfield compile path, end-to-end

1. **Author** — a `prisma/guarddog.ts` file `export default`s a value from `defineSchema({...})`. Claims, dbRoles, appRoles, resources, optional resourceGrants, and optional managed functions are declared via the core primitives. The `policies(guard)` callback authors per-model policies, polymorphic targets, column privileges, restrictive isolation floors, and `noPolicy()` opt-outs.

2. **Materialize** — `materializeSchema(schemaDef)` (in core) turns the declarative value into a `Guarddog` instance. The CLI's `loadSchema` (jiti-backed) handles the file load; tests can call `materializeSchema` directly.

3. **Compile** — `compileToOps(guard)` walks the Guarddog into a deterministic `Op[]`. Each op is **intent-level**: `create-role`, `enable-rls`, `create-policy` (carrying the full `Expr` tree, not SQL), `grant-column`, etc. Polymorphic targets fuse their discriminator equality into `using` / `check` at this stage. Restrictive policies carry the `restrictive: true` flag and a `verb: 'all'` op; the auto-name `<table>_isolation` resolves here for `.isolation()` sugar. See [ADR-0007](./adr/0007-forward-replay-state-derivation.md), [ADR-0032](./adr/0032-restrictive-policy-support.md).

4. **Diff** — `applyOps(empty(), historicalOps)` forward-replays every `guarddog.json` sidecar found under the configured migrations directory to derive the current declared `State`. `diffStates(current, target)` produces the minimal `Op[]` to transform one into the other. Drops precede adds; roles outlive their dependents on the way down; on the way up RLS comes up before policies. Policy content drift (including permissive ↔ restrictive flips) is treated as drop+create.

5. **Render** — `renderOps(ops, { claims, resourceGrants, functionSchema })` (in the CLI) dispatches per-op kind to the emitter primitives. `create-policy` delegates predicate compilation to `compileExpr` in `emitter-postgres-rls` so polymorphic-discriminator fusion, claim-jsonb lookups, resource-grant rewriting, and managed-function calls all share one implementation. `AS RESTRICTIVE FOR ALL` ships on restrictive ops. Column ops render via `emitter-postgres-column-privileges`. Role lifecycle ops use `pg_roles` / `pg_auth_members`-guarded `DO` blocks. Every emitted policy carries a `prisma-guarddog:managed` ownership comment ([ADR-0029](./adr/0029-handling-existing-rls-policies.md)).

6. **Persist** — `runMigrate` allocates `prisma/migrations/<YYYYMMDDHHMMSS>_<slug>/`, writes `migration.sql` (the rendered DDL) and `guarddog.json` (the original `Op[]` as a sidecar). Prisma's migration runner picks the SQL up alongside any Prisma-authored migrations.

7. **Verify** — `testing-postgres` exposes `withScenario(client, { role, claims }, fn)` plus assertion helpers. Each scenario opens a transaction, installs the test identity, runs assertions, rolls back. [ADR-0013](./adr/0013-real-postgres-required-for-tests.md) hard-requires real Postgres — no `pg-mem` / `pglite` shims, because they don't implement enough of `SET ROLE`, `current_setting`, and column GRANTs to give honest signal.

## The brownfield adoption path

Phase 1.5 layered an adoption pipeline on top of the same packages. The bug class it prevents: legacy permissive policies coexisting with guarddog's during the cutover window, OR-ing access **wider** than intended.

1. **Inventory** — `importer-postgres`'s `readPolicyInventory(client, { schema })` reads `pg_policies` + `pg_description` and returns one row per live policy. Carries `permissive: boolean`, the catalog comment (if any), and the verb. The ownership comment scheme stamps every guarddog-emitted policy with `prisma-guarddog:managed`; `adopt --keep` stamps acknowledged foreigns with `prisma-guarddog:ignore`. The drift engine reads both.

2. **Classify** — `computePolicyDrift(declared, live)` in `packages/cli/src/drift.ts` returns:
   - `foreign` — live policies on a managed table that guarddog neither declares nor marked. Permissive ones are wideners — the headline risk.
   - `staleManaged` — `:managed`-stamped policies guarddog no longer declares (safe to drop).
   - `missing` — declared but absent from `pg_policies` (not applied, or drifted away).
   - `restrictivenessMismatch` — same `(table, name)` in both, but permissive vs restrictive disagrees ([ADR-0032](./adr/0032-restrictive-policy-support.md)).
   - `acknowledged` — `:ignore`-stamped foreigns the operator deliberately kept; reported, not flagged.

3. **Triage** — `guarddog adopt --against <url>` walks every foreign policy and prompts for a disposition. `planAdoption(...)` maps dispositions to effects: `keep` → stamp `:ignore`; `remove` → emit `drop-policy`; `edit` → scaffold `.rawSql(<legacy>) + .named(<legacy>) + .todo()`; `override` → scaffold a fresh `.todo()` stub (legacy SQL discarded); `skip` → leave alone, re-surface next run. See [ADR-0030](./adr/0030-interactive-adoption-triage.md).

4. **In-place upgrade** — `.named()` chained or `{ name }` per verb declares a legacy policy name on a typed replacement. The emit renders `DROP POLICY IF EXISTS <legacy>; CREATE POLICY <legacy> …` so the typed predicate swaps in **atomically**, with no widening window from coexisting auto-gen and legacy names. The duplicate-name guard in `compileToOps` rejects two declared policies sharing `(table, name)` at compile time. See [ADR-0031](./adr/0031-user-declared-policy-names.md).

5. **Cut over** — `guarddog migrate --drop-unmanaged --against <url>` prepends `drop-policy` ops for every foreign / stale-managed policy on a managed table, then emits the normal greenfield ops on top. Conservative by default — `--drop-unmanaged` is opt-in.

The four steps interlock. `adopt --edit` scaffolds exactly what `.named()` needs to upgrade atomically; restrictive `isolation(fn, { name: 'tenant_isolation' })` upgrades a hand-written restrictive floor in place; drift catches every mismatch the path would otherwise paper over.

## Where each package lives across both paths

| Package | Greenfield steps | Brownfield steps | Role |
| --- | --- | --- | --- |
| [`@flowchestra/prisma-guarddog-core`](../packages/core) | 1–4 | scaffold consumers; duplicate-name guard | DSL primitives, AST, Op union, compile + diff |
| [`@flowchestra/prisma-guarddog-emitter-postgres-rls`](../packages/emitter-postgres-rls) | 5 | — | `Expr` → SQL fragments; `PolicyAst` → idempotent `CREATE POLICY` (incl. `AS RESTRICTIVE`) |
| [`@flowchestra/prisma-guarddog-emitter-postgres-column-privileges`](../packages/emitter-postgres-column-privileges) | 5 | — | `ColumnPrivilegeAst` → `GRANT` / `REVOKE` |
| [`prisma-guarddog`](../packages/cli) (CLI) | 2, 5, 6 | 1–5 | jiti loader, `renderOps`, `migrate` / `check` / `drift` / `adopt` / `import` / `diff` / `emit` |
| [`@flowchestra/prisma-guarddog-importer-prisma`](../packages/importer-prisma) | side | side | Prisma DMMF readers + model column-type codegen |
| [`@flowchestra/prisma-guarddog-importer-postgres`](../packages/importer-postgres) | side | 1, 3 | `pg_policies` inventory + `rawSql() + .todo()` scaffold |
| [`@flowchestra/prisma-guarddog-testing-postgres`](../packages/testing-postgres) | 7 | — | `withScenario` + assertion helpers |
| [`@flowchestra/prisma-guarddog-lint`](../packages/lint) | side | side | Coverage check; nudges declared-name use, todo markers, raw-SQL policies, column-privilege enforcement gap |
| [`@flowchestra/prisma-guarddog-preset`](../packages/preset-flowchestra) | 1 | 1 | Opinionated preset (claims, roles, resources) — example of a downstream preset |

The dependency graph fans out from `core`. Every non-CLI package depends only on `core` (plus, in the emitter case, dialect-specific helpers). The CLI is the only package that depends on multiple emitter packages; this is intentional — `renderOps` is the dispatcher.

## The Op union: why intent, not SQL

`compileToOps` produces ops that carry the `Expr` tree, not pre-rendered SQL. The sidecar JSON written next to each migration captures that intent — so forward replay reconstructs the same declared `State` regardless of dialect, and a future emitter (e.g., a different RDBMS) can render the same ops differently.

This also means policy-content drift is exact: two policies with the same name but different `using` expressions compare unequal at the AST level, and the diff emits a clean drop+create pair rather than trying to `ALTER POLICY` (which Postgres only partially supports). The `restrictive` flag rides on the same record — a permissive ↔ restrictive flip on the same `(table, name)` forces drop+recreate.

## Self-contained emission

The emitted SQL never depends on consumer-side helper functions or an `app.*` schema outside the ones guarddog manages itself. The three-permission-layer predicates compile inline:

- `p.hasAppRole('workspace.admin')` → `(claims -> 'roles') ? 'workspace.admin'`
- `p.hasGrant('write', col('workspaceId'))` → `(claims -> 'grants' -> 'write') ? "workspaceId"::text`
- `p.hasResourcePermission('read', col('permissions'))` → `(permissions -> 'roles' -> '...') ? 'read'`

`p.fn('current_tenant_id')` calls a guarddog-managed function (declared via `defineFunctions`, [ADR-0026](./adr/0026-managed-sql-functions.md)) that guarddog itself emits via `CREATE OR REPLACE FUNCTION` with `GRANT EXECUTE`. The compiler owns the function lifecycle — no consumer-side helper bootstrap required.

Role lifecycle wraps `CREATE ROLE` / `GRANT … TO …` in `pg_roles` / `pg_auth_members`-guarded `DO` blocks so the migration is idempotent on re-runs.

## What's out of scope

These are deliberate non-goals, not "later":

- **Runtime middleware / Prisma client extension** — [ADR-0001](./adr/0001-policy-compiler-not-runtime-middleware.md). All enforcement happens in Postgres.
- **In-memory test shims** — [ADR-0013](./adr/0013-real-postgres-required-for-tests.md).
- **A non-TypeScript DSL** — [ADR-0015](./adr/0015-typescript-as-dsl.md).
- **A compiled Go/Rust binary** — [ADR-0017](./adr/0017-typescript-implementation.md).
- **Warehouse / datalake coverage** — different access model.

## Further reading

- [`docs/PLAN.md`](./PLAN.md) — phased roadmap, definition of done, Phase 1 / 1.5 / 2 / 3 status
- [`docs/GLOSSARY.md`](./GLOSSARY.md) — vocabulary (three permission layers, topology, adoption terms)
- [`docs/adr/`](./adr/) — 32 architecture decision records
- [`examples/flowchestra`](../examples/flowchestra) — seven representative policies + opt-in real-Postgres E2E suite
