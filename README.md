# prisma-guarddog

> A schema-driven policy compiler for Prisma-backed Postgres applications.

[![Release](https://github.com/Flowchestra/prisma-guarddog/actions/workflows/release.yml/badge.svg)](https://github.com/Flowchestra/prisma-guarddog/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-blue.svg)](./package.json)
[![ADRs](https://img.shields.io/badge/ADRs-32-blueviolet.svg)](./docs/adr/)
[![Phase 1](https://img.shields.io/badge/Phase%201-complete-success.svg)](./docs/PLAN.md)
[![Phase 1.5](https://img.shields.io/badge/Phase%201.5-complete-success.svg)](./docs/PLAN.md)
[![Status](https://img.shields.io/badge/release-0.1.0--alpha.13-orange.svg)](./CHANGELOG.md)

Author Postgres RLS policies, role graphs, column privileges, and resource grants in **one TypeScript schema file** — conventionally `prisma/guarddog.ts`, sibling to `schema.prisma`. The CLI diffs that schema against your previous migrations and writes a fresh `prisma/migrations/<timestamp>_<slug>/` containing idempotent SQL plus a typed sidecar. `prisma migrate` applies it like any other migration.

The mental model parallels Prisma's: schema in, autocomplete + LSP linting, idempotent migrations out, applied via Prisma's standard runner. **The runtime is invisible to the consumer**; the schema file is the value-prop.

`prisma-guarddog` is a **policy compiler**, not a runtime authorization framework. All enforcement happens in Postgres — no Prisma client extension, no middleware, no app-layer WHERE injection ([ADR-0001](./docs/adr/0001-policy-compiler-not-runtime-middleware.md)).

---

## At a glance

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
    // One restrictive floor — tenant isolation, AND'd with every other policy.
    guard.model('Workspace')
      .isolation((p) => p.claim('tenantId').eq(col('tenantId')))
      // Permissive access — the floor is already enforced.
      .policy('app_user')
        .select((p) => p.literal(true))
        .insert({ check: (p) => p.hasAppRole('workspace.admin') })
  },
})
```

```sh
guarddog migrate --slug initial-policies
# writes prisma/migrations/<timestamp>_initial-policies/migration.sql
#        prisma/migrations/<timestamp>_initial-policies/guarddog.json
prisma migrate deploy
```

The migration is fully self-contained — no consumer-side helper functions, no `app.*` schema needed, no SQL between the schema file and a working database.

---

## Status

| Aspect | State |
| --- | --- |
| **Release** | `0.1.0-alpha.13` on GitHub Packages (alpha.14 queued); public npm post-alpha. |
| **Phase 1** (foundations) | **Complete.** DSL, compile pipeline, idempotent SQL, sidecar replay. |
| **Phase 1.5** (adoption + drift) | **Complete.** Foreign-policy drift, interactive adopt triage, named policies, restrictive policies. |
| **Phase 2** (provider + visibility) | In progress. FDW tables, row-conditional masking, Supabase importer. |
| **Tests** | 526 unit tests + 31 real-Postgres E2E scenarios across the workspace. |
| **CI** | Type-check / lint / build / unit on every push + PR; real-Postgres E2E in a service container; Changesets-driven release on `main`. |

The `0.1.0-alpha.x` line is internal-alpha; breaking changes are expected and intentional. Rough edges are part of the deal — adopting consumers will find them and that's the point.

---

## Core concepts

Four primitives, four short reads. Each links to the ADR that pins down the decision.

### 1. Typed model + column references

Pass the generated `ModelColumns` const and `guard.model(...)` / `p.col(...)` autocomplete and type-check against your Prisma schema (sourced from DMMF, post-`@map`). A typo'd column is a compile error, not an apply-time Postgres error — see [ADR-0028](./docs/adr/0028-typed-model-and-column-references.md).

```ts
import { ModelColumns } from './generated/guarddog-models' // emitted by the guarddog Prisma generator

export default defineSchema({
  models: ModelColumns, // ← inferred; no explicit generic
  policies(guard) {
    guard
      .model('Workspace') // ← model names autocomplete; typo = type error
      .policy('app_user')
      .select((p) => p.col('tenantId').eq(p.claim('tenantId'))) // ← p.col autocompletes Workspace's columns
  },
})
```

`p.col` is the typed, model-scoped form; `col(...)` stays as the untyped escape hatch for dynamic column names. Omit `models` and both stay unconstrained (`string`) — fully backward compatible.

### 2. Restrictive policies — the inescapable floor

Postgres permissive policies **OR together**; one missing inline floor in a permissive `USING` is enough to leak. `.isolation(fn)` declares the tenant + soft-delete floor **once per table** as `AS RESTRICTIVE FOR ALL TO public`. The floor is AND'd with every other policy — future permissives (break-glass, support tools, shared-link) **cannot escape it** ([ADR-0032](./docs/adr/0032-restrictive-policy-support.md)).

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

`.isolation()` desugars to `.restrictivePolicy('public').forAll(fn)` with the auto-name `<table>_isolation`. The low-level `.restrictivePolicy(role)` is the escape hatch for non-`PUBLIC` roles or distinct floors.

### 3. Adopting onto a database with existing policies

Every policy guarddog creates carries an ownership comment, so the drift engine can distinguish guarddog's policies from the hand-written ones already in your database. On adoption that matters: a leftover legacy permissive policy silently **widens** access (a classic case: a `FOR ALL` policy that leaks soft-deleted rows surviving the cutover) — see [ADR-0029](./docs/adr/0029-handling-existing-rls-policies.md).

```sh
# Report drift between the declared schema and a live database (read-only).
# Flags foreign policies on guarddog-managed tables; permissive ones are wideners.
guarddog drift --against "$DATABASE_URL"        # --exit-code to gate CI

# Interactively triage each existing policy — keep / remove / edit / override.
guarddog adopt --against "$DATABASE_URL"

# Cut over: prepend DROP POLICY for foreign/legacy policies, then create guarddog's.
guarddog migrate --drop-unmanaged --against "$DATABASE_URL"
```

Conservative by default — `migrate` never drops a foreign policy unless you pass `--drop-unmanaged`, and `adopt` only writes the keep-marks / drops you confirm per policy ([ADR-0030](./docs/adr/0030-interactive-adoption-triage.md)).

### 4. Named policies — atomic in-place legacy upgrades

For an atomic, in-place upgrade of a legacy policy (no widening window during the cutover), declare the legacy name on the typed replacement. The emit renders `DROP POLICY IF EXISTS <legacy>; CREATE POLICY <legacy> …` so the typed predicate swaps in place. Lint warns to nudge you back to the auto-gen convention once adoption is complete ([ADR-0031](./docs/adr/0031-user-declared-policy-names.md)).

```ts
guard.model('Workspace').policy('app_user')
  .named('workspaces_visibility_select')                             // legacy name preserved
  .select((p) => p.col('tenantId').eq(p.claim('tenantId')))          // typed replacement, in-place
  .insert({ check: (p) => …, name: 'workspaces_visibility_insert' }) // per-verb wins
```

Pairs with `.isolation(fn, { name: 'tenant_isolation' })` to upgrade an existing hand-written restrictive floor in place.

---

## Quickstart

Packages publish to **GitHub Packages** under the `@flowchestra` scope. Two `.npmrc` lines required — typically in your repo or `~/.npmrc`:

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

Create `prisma/guarddog.ts` and `export default defineSchema({...})`. See [`examples/flowchestra`](./examples/flowchestra) for a complete realistic schema. Releases are driven by Changesets; details in [`RELEASING.md`](./RELEASING.md).

---

## Architecture

Nine packages plus an example, all in this workspace. `core` is the only required dependency for downstream packages; the CLI is the dispatcher that pulls the emitters together.

<!-- markdownlint-disable MD060 -->

| Package | Purpose |
| --- | --- |
| [`@flowchestra/prisma-guarddog-core`](./packages/core/README.md) | DSL primitives, AST, Op union, compile + diff |
| [`@flowchestra/prisma-guarddog-emitter-postgres-rls`](./packages/emitter-postgres-rls/README.md) | `Expr` → SQL; `PolicyAst` → `CREATE POLICY`; restrictive emission; role lifecycle |
| [`@flowchestra/prisma-guarddog-emitter-postgres-column-privileges`](./packages/emitter-postgres-column-privileges/README.md) | `ColumnPrivilegeAst` → `GRANT` / `REVOKE` |
| [`prisma-guarddog`](./packages/cli/README.md) (CLI) | `migrate`, `check`, `drift`, `adopt`, `import`, generator binary |
| [`@flowchestra/prisma-guarddog-importer-prisma`](./packages/importer-prisma/README.md) | Prisma DMMF readers + model-type codegen |
| [`@flowchestra/prisma-guarddog-importer-postgres`](./packages/importer-postgres/README.md) | `pg_policies` → scaffold (`rawSql()` + `.todo()`) |
| [`@flowchestra/prisma-guarddog-testing-postgres`](./packages/testing-postgres/README.md) | `withScenario` + assertion helpers (real-PG only) |
| [`@flowchestra/prisma-guarddog-lint`](./packages/lint/README.md) | Coverage + WIP + declared-name + column-privilege-enforcement checks |
| [`@flowchestra/prisma-guarddog-preset`](./packages/preset-flowchestra/README.md) | Opinionated preset (reference for downstream presets) |

<!-- markdownlint-enable MD060 -->

End-to-end compile path, package interaction diagram, and the Op-union rationale all live in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md). Read that first.

---

## Why

Hand-rolling RLS across dozens or hundreds of tables — plus column privileges, polymorphic grants, an evolving role graph, and a soft-delete + tenant floor that must apply to every access path — does not scale. Existing tools fall short:

- **ZenStack** enforces at the app layer, not at the DB.
- **Yates** is Prisma 4.x only, no column-level security, no polymorphic relations, no composable predicates.
- **Atlas** generates migrations but policies are still hand-written SQL (and the diff feature is Pro-tier).
- **Supabase declarative schemas** explicitly skip RLS and column privileges in `migra`.

`prisma-guarddog` exists to be the policy compiler in this space — schema-driven, TypeScript-native, Postgres-emitting, multi-package extensible.

Full evaluation: [ADR-0002 — Evaluated and rejected alternatives](./docs/adr/0002-evaluated-and-rejected-alternatives.md).

---

## Running the tests

```sh
pnpm install
pnpm -r run test     # 526 unit tests, no DB required
pnpm test:e2e        # boots throwaway postgres:16 via Docker, runs E2E, tears it down
```

`pnpm test:e2e` is zero-config — Docker is the only dependency. To point at your own database (e.g. local Supabase on port 54322), copy `.env.example` to `.env` and set `GUARDDOG_DATABASE_URL`. **Hosted Supabase will not work** — the suites `CREATE` / `DROP` roles, which the hosted `postgres` user lacks privilege for.

---

## Roadmap

- **Phase 1** — Foundations. **Complete.** DSL, compile pipeline, idempotent SQL, sidecar replay, real-Postgres harness, 9-package monorepo.
- **Phase 1.5** — Adoption + drift. **Complete.** Foreign-policy drift detection ([ADR-0029](./docs/adr/0029-handling-existing-rls-policies.md)), interactive adopt triage ([ADR-0030](./docs/adr/0030-interactive-adoption-triage.md)), user-declared names ([ADR-0031](./docs/adr/0031-user-declared-policy-names.md)), restrictive policies + isolation sugar ([ADR-0032](./docs/adr/0032-restrictive-policy-support.md)).
- **Phase 2** — Provider + visibility extensions. **In progress.** FDW table support, row-conditional field masking (`.masks()` / `.projection()`), Supabase-specific importer. Column-privilege base-table REVOKE prelude ([issue #2](https://github.com/Flowchestra/prisma-guarddog/issues/2)) lands here.
- **Phase 3** — Identity provider integration. WorkOS FGA bridge (actions → composable roles → grant cascade).

Full plan with definition-of-done: [`docs/PLAN.md`](./docs/PLAN.md).

---

## Documentation

- **[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)** — system overview, package map, end-to-end compile path *(start here)*
- **[`docs/README.md`](./docs/README.md)** — documentation hub: per-package links, ADRs by category
- **[`docs/PLAN.md`](./docs/PLAN.md)** — phased roadmap
- **[`docs/GLOSSARY.md`](./docs/GLOSSARY.md)** — vocabulary (three permission layers, scope cascade, adoption terms)
- **[`docs/adr/`](./docs/adr/)** — 32 architecture decision records
- **[`examples/`](./examples/README.md)** — working end-to-end examples

---

## License

[MIT](./LICENSE)
