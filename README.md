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

### Typed model + column references (optional)

Pass the generated `ModelColumns` const and `guard.model(...)` + `p.col(...)` autocomplete and type-check against your Prisma schema (sourced from DMMF, post-`@map`) — a typo'd column is a compile error, not an apply-time Postgres error ([ADR-0028](./docs/adr/0028-typed-model-and-column-references.md)):

```ts
import { ModelColumns } from './generated/guarddog-models' // emitted by the guarddog Prisma generator

export default defineSchema({
  models: ModelColumns, // ← inferred; no explicit generic
  // ...claims/dbRoles/etc.
  policies(guard) {
    guard
      .model('Workspace') // ← model names autocomplete; typo = type error
      .policy('app_user')
      .select((p) => p.col('tenantId').eq(p.claim('tenantId'))) // ← p.col autocompletes Workspace's columns
  },
})
```

`p.col` is the typed, model-scoped form; the standalone `col(...)` stays as the untyped escape hatch for dynamic/raw column names. Omit `models` and both stay unconstrained (`string`) — fully backward compatible.

### Adopting onto a database with existing policies

guarddog stamps every policy it creates with an ownership comment, so it can tell its policies from the hand-written ones already in your database. On adoption that matters: Postgres permissive policies **OR together**, so a leftover legacy policy silently *widens* access (a classic case: a `FOR ALL` policy that leaks soft-deleted rows surviving the cutover). See [ADR-0029](./docs/adr/0029-handling-existing-rls-policies.md).

```sh
# Report drift between the declared schema and a live database (read-only).
# Flags foreign policies on guarddog-managed tables; permissive ones are access-wideners.
guarddog drift --against "$DATABASE_URL"        # --exit-code to gate CI

# Interactively triage each existing policy — keep / remove / edit / override (ADR-0030).
# `keep` marks it acknowledged (drift stops flagging it); `edit`/`override` emit a
# scaffold to fold into guarddog.ts; `remove` drops it.
guarddog adopt --against "$DATABASE_URL"

# Cut over: prepend DROP POLICY for foreign/legacy policies, then create guarddog's.
guarddog migrate --drop-unmanaged --against "$DATABASE_URL"
```

Conservative by default — `migrate` never drops a foreign policy unless you pass `--drop-unmanaged`, and `adopt` only writes the keep-marks/drops you confirm per policy.

For an **atomic, in-place upgrade** of a legacy policy (no widening window during the cutover), declare the legacy name on the typed replacement — `.named()` chained, or `{ name }` per verb. The emit renders `DROP POLICY IF EXISTS <legacy>; CREATE POLICY <legacy> …` so the typed predicate swaps in place. Lint warns to nudge you back to the auto-gen convention once adoption is complete ([ADR-0031](./docs/adr/0031-user-declared-policy-names.md)):

```ts
guard.model('Workspace').policy('app_user')
  .named('workspaces_visibility_select')                              // legacy name preserved
  .select((p) => p.col('tenantId').eq(p.claim('tenantId')))           // typed replacement, in-place
  .insert({ check: (p) => …, name: 'workspaces_visibility_insert' }) // per-verb wins
```

### Restrictive policies — the inescapable floor

Postgres permissive policies **OR together**; one missing inline floor in a permissive `USING` is enough to leak. `.isolation(fn)` declares the tenant + soft-delete floor **once per table** as `AS RESTRICTIVE FOR ALL TO public`. The floor is AND'd with every other policy — future permissives (break-glass, support tools, shared-link) **cannot escape it** ([ADR-0032](./docs/adr/0032-restrictive-policy-support.md)):

```ts
guard.model('Workspace').table('workspaces')
  // One restrictive floor — applies to SELECT, INSERT, UPDATE, DELETE.
  .isolation((p) =>
    p.fn('current_tenant_id').eq(col('tenant_id')).and(p.raw('deleted_at IS NULL'))
  )
  // Permissive — just access. The floor is already AND'd.
  .policy('app_user')
    .select((p) => p.hasGrant('workspace.read', col('id')))
```

`.isolation()` desugars to `.restrictivePolicy('public').forAll(fn)` with the auto-name `<table>_isolation`. The low-level `.restrictivePolicy(role)` is the escape hatch for non-PUBLIC roles or distinct floors. Pairs with `.named()` for legacy-name parity: `.isolation(fn, { name: 'tenant_isolation' })` upgrades an existing hand-written restrictive in place.

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

**Phase 1 implementation complete; internal alpha.** 382 unit tests + 13 real-Postgres E2E scenarios pass across the workspace. Currently published as `0.1.0-alpha.1` on GitHub Packages under the `@flowchestra` scope; the `0.1.x` alpha line is internal and expected to carry breaking changes. Public npm distribution is the post-alpha goal. **Rough edges are expected — adopting consumers will find them, and that's the point of the alpha.**

### Running the tests

```sh
pnpm install
pnpm -r run test     # unit tests, no DB required
pnpm test:e2e        # boots throwaway postgres:16 via Docker, runs E2E, tears it down
```

`pnpm test:e2e` is zero-config — Docker is the only dependency. To point at your own database (e.g. local Supabase on port 54322), copy `.env.example` to `.env` and set `GUARDDOG_DATABASE_URL`. **Hosted Supabase will not work** — the suites CREATE/DROP roles, which the hosted `postgres` user lacks privilege for.

### What's verified vs. what's not

| Verified | Not yet verified |
| --- | --- |
| DSL, compile pipeline, diff, render, sidecar replay (382 unit tests) | `runMigrate` file-writing path (no test exercises the actual filesystem emit yet) |
| Real-Postgres semantic enforcement (13 E2E scenarios via `pnpm test:e2e`) | `npm publish --dry-run` clean across all 9 packages (pack + install harness pending; tracked with the publishing flow) |
| `planMigrate` produces correct ops + SQL | Bin smoke against a fresh CWD (`node packages/cli/dist/bin.cjs` from outside the workspace — same blocker as the publish dry-run) |
| Per-package type-check + lint clean; workspace `pnpm -r run build` end-to-end in CI | |
| `loadSchema`'s validate + materialize helpers (incl. jiti-from-disk) | |
| Coverage lint, flowchestra preset, and the example schema's canonical `defineSchema` form | |
| Release pipeline (`.github/workflows/release.yml`) + changesets prerelease mode + CI E2E job with `postgres:16` service container | |
| `.polymorphic()` end-to-end against real Postgres (flowchestra example + synthetic discriminator) | |
| Importer scaffold round-trip: real PG → `runImport` → `loadSchema` → materialized Guarddog | |
| 7 proof-of-API models in `examples/flowchestra` covering every Phase 1 scenario in PLAN.md (tenant-only, workspace+role, workbench cascade, nullable-workbench file, owner pattern, polymorphic, opted-out noPolicy) | |
| Idempotent re-apply of rendered SQL (`pg_policies` + `pg_roles` snapshot unchanged after second apply) | |
| CLI: `guarddog check` (incl. `--lint`), `migrate`, `emit`, `diff`, `import` | |

See [`docs/PLAN.md`](./docs/PLAN.md) for the full phased roadmap and definition of done.

### Phase 1 known constraints

Two things consumers will hit. Neither is a showstopper, but pretending they don't exist would set bad expectations.

1. **`.columnPrivileges()` declarations are not self-enforcing.** The emitter grants to the declared role but does not revoke from anyone else. Any pre-existing table-wide `GRANT SELECT ... TO some_role` will override what the column-privilege declaration looks like it's locking down. Workaround: scope base-table grants by column (or issue REVOKEs in the prelude). The flowchestra example documents the pattern inline. Tracked as [issue #2](https://github.com/Flowchestra/prisma-guarddog/issues/2) with three design options for the fix.

2. **No publish dry-run gate yet.** Packaging looks correct (every package has `publishConfig` + `files` set), and recent versions published cleanly via the changesets workflow. But the workspace dev exports field (which points at `./src/index.ts` so jiti and vitest both work) interferes with a pack-and-install smoke test from outside the tree. The proper fix lives in the publish dry-run harness; the bin works correctly when consumed from a real installation.

> **Note:** `resourceGrants.source: 'table'` (per-resource overrides + polymorphic fallback) shipped in `0.1.0-alpha.2` ([ADR-0021](./docs/adr/0021-table-backed-resource-grants.md)). `0.1.0-alpha.3` adds **rank-based grants** (`roleColumn` + `roleHierarchy`, [ADR-0022](./docs/adr/0022-rank-based-grant-tables.md)), **user-OR-group principal disjunction** (`groupMemberTable`, [ADR-0023](./docs/adr/0023-grant-principal-disjunction.md)), and **CLI-threaded `renderOverrides`** via `guarddog.config.ts` ([ADR-0024](./docs/adr/0024-config-threaded-render-overrides.md)). `0.1.0-alpha.4` adds a **per-call `hasGrant` table hint** (`p.hasGrant(action, col('id'), { table })`) for own-row grant checks where two policies key on the same column ([ADR-0025](./docs/adr/0025-hasgrant-per-call-table-hint.md)); `0.1.0-alpha.5` makes that hint **type-safe** — it autocompletes against the declared `tables` keys and rejects typos at compile time. `0.1.0-alpha.6` adds **guarddog-managed SQL functions** — `defineFunctions({ schema, fns })` emits and signature-diffs `CREATE OR REPLACE FUNCTION` DDL + `GRANT EXECUTE`, and `p.fn(name, ...args)` calls them from policies with name autocomplete + arity checking ([ADR-0026](./docs/adr/0026-managed-sql-functions.md)).

## Roadmap

- **Phase 2** — FDW table support, row-conditional field masking (`.masks()` / `.projection()`), Supabase-specific importer. (Table-backed `resourceGrants` source originally tracked here shipped in `0.1.0-alpha.2`.)
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
