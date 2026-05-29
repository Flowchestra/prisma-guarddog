# Plan

## Vision

`prisma-guarddog` is a TypeScript policy compiler and verification harness for Prisma-backed Postgres applications. It emits Postgres RLS DDL, role grants, column privileges, sidecar migration metadata, and test scaffolds — all driven by policies authored in TypeScript and typed against the consumer's generated Prisma client.

## Phases

### Phase 1 — Foundations (implementation complete; release prep in progress)

Scope is **locked**. The exit criteria below are deliberately narrow; do not propose adding to Phase 1.

**Status** (as of 2026-05-23): every Phase 1 deliverable has landed and 374 unit tests pass across the workspace. Remaining gates before tagging a release: opt-in real-Postgres E2E run, workspace `pnpm -r run build` verification, CI workflow, version planning. See the root README's "What's verified vs. what's not" section.

#### Deliverables

**Core (`@flowchestra/prisma-guarddog-core`)**

- `defineClaims()`, `defineDbRoles()`, `defineAppRoles()`, `defineResources()`, `defineResourceGrants()`, `defineSchema()`
- `new Guarddog({...})` constructor with `.model()`, `.policy()`, `.columnPrivileges()`, `.polymorphic()`, `.noPolicy()`, `.rawSql()`, `.todo()` builders
- **Functional lifecycle** — `compileToOps`, `compileToState`, `diffStates`, `applyOps`: pure functions over an Op-union state, not instance methods. See [ADR-0020](./adr/0020-functional-lifecycle-over-op-union.md).
- Pure typed AST output; no SQL emission in core

**Emitters**

- `@flowchestra/prisma-guarddog-emitter-postgres-rls` — `CREATE POLICY`, `ENABLE/FORCE ROW LEVEL SECURITY`, table-level `REVOKE`
- `@flowchestra/prisma-guarddog-emitter-postgres-column-privileges` — column `GRANT`/`REVOKE`

**Importers (scaffold-mode only)**

- `@flowchestra/prisma-guarddog-importer-prisma` — DMMF → coverage check + model stubs
- `@flowchestra/prisma-guarddog-importer-postgres` — `pg_policies` + column privileges → TS scaffolds with `rawSql()` + `.todo()` + `noPolicy()` stubs

**Testing**

- `@flowchestra/prisma-guarddog-testing-postgres` — `withDbRole`, `withClaims`, `assertAllowed`, `assertDenied`, `assertVisibleRows`, `assertHiddenColumns`. Real Postgres only (no shims).

**Lint**

- `@flowchestra/prisma-guarddog-lint` — every Prisma model must have `policy()`, `noPolicy()`, or `importedRawPolicy()`. CI fails otherwise.

**Preset**

- `@flowchestra/prisma-guarddog-preset` — `createFlowchestraGuarddog({ prisma, claimsAccessor })`

**CLI**

- `prisma-guarddog` (unscoped binary name; package `@flowchestra/prisma-guarddog`) — `guarddog check / migrate` shipped; `guarddog emit / diff / import` planned.

**Proof-of-API**

- 5 representative tables authored against the Flowchestra schema, exercising:
  1. Tenant-scoped only
  2. Workspace-scoped with role-gated mutations
  3. Workbench-scoped with nullable `workbenchId`
  4. Column-level masking case (column privileges path)
  5. Polymorphic grant case (discriminated-union table)
- End-to-end integration tests for each, using `@flowchestra/prisma-guarddog-testing-postgres`

#### Definition of done

- All Phase 1 packages publish dry-run cleanly to npm
- 5 proof tables emit idempotent SQL that re-applies as no-op
- E2E tests pass against real Postgres in CI
- `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm build` all pass at the workspace root
- ADRs 0001–0017 merged before any Phase 1 implementation lands. (Subsequent decisions captured during build: [ADR-0018](./adr/0018-schema-file-as-primary-interface.md) on the schema-file authoring surface, [ADR-0019](./adr/0019-three-permission-layers-and-resource-permissions.md) on the three-permission-layer model superseding the earlier four-primitive framing, and [ADR-0020](./adr/0020-functional-lifecycle-over-op-union.md) on the functional lifecycle.)

### Phase 2 — Provider and visibility extensions

- **FDW table support** — emitter handles foreign tables with no native tenant column; policies join through the FDW (`@flowchestra/prisma-guarddog-emitter-fdw`)
- **Row-conditional field masking** — `.masks()` / `.projection()` builders; emitted via generated secure views or projection functions
- **Supabase-specific importer** — pulls policies via Supabase REST/dashboard rather than direct `pg_policies` (`@flowchestra/prisma-guarddog-importer-supabase`)
- ~~**Table-backed `resourceGrants` source**~~ — **shipped in `0.1.0-alpha.2`** via `defineResourceGrants({ source: 'table', tables: {...}, fallbackTable: {...} })`. Supports per-resource grant tables + polymorphic fallback. See [ADR-0021](./adr/0021-table-backed-resource-grants.md).
- ~~**Rank-based + group-disjunctive grant tables**~~ — **shipped in `0.1.0-alpha.3`** (pulled forward from a would-be Phase 2.5 after the Flowchestra pilot, issues #5/#6): `roleColumn` + `roleHierarchy` rank semantics ([ADR-0022](./adr/0022-rank-based-grant-tables.md)) and `principalUserColumn`/`principalGroupColumn`/`groupMemberTable` user-OR-group resolution ([ADR-0023](./adr/0023-grant-principal-disjunction.md)). Plus CLI-threaded render overrides ([ADR-0024](./adr/0024-config-threaded-render-overrides.md)).
- ~~**`hasGrant` per-call table hint**~~ — **shipped in `0.1.0-alpha.4`** (issue #11, [ADR-0025](./adr/0025-hasgrant-per-call-table-hint.md)): `p.hasGrant(action, col('id'), { table })` for own-row grant checks across multiple resources. **Type-safe autocomplete on the hint key shipped in `0.1.0-alpha.5`** (issue #12) — a `TGrantTableKeys` generic threaded from `defineResourceGrants` through `Guarddog`/`PredicateBuilder`; the hint autocompletes and typos are type errors. Backward compatible (defaults to `string`).
- ~~**guarddog-managed SQL functions**~~ — **shipped in `0.1.0-alpha.6`** (issue #15, [ADR-0026](./adr/0026-managed-sql-functions.md)): `defineFunctions({ schema, fns })` emits + signature-diffs `CREATE OR REPLACE FUNCTION` DDL, `CREATE SCHEMA`, and `GRANT EXECUTE`; `p.fn(name, ...args)` calls them from policies with name autocomplete + arity checking (a `TFunctions` generic mirroring the `TGrantTableKeys` thread). Resolves the inline-vs-rawSql tension for bespoke authz logic (creator-implicit-OWNER, custom JOINs, shared rank mappers) while honoring self-contained emission ([ADR-0001](./adr/0001-policy-compiler-not-runtime-middleware.md)) — guarddog owns the functions.

### Phase 3 — Identity provider integration

- **WorkOS FGA bridge** — `@flowchestra/prisma-guarddog-fga-workos`
- Translates WorkOS actions + composable roles → guarddog `appRoles` and grant predicates
- Emitted policies call `app.*` functions that resolve FGA relationships at query time

### Out of scope (entirely, not "Phase 4")

- Warehouse / datalake coverage — different access model, different security primitives
- Runtime enforcement / Prisma client extension — see [ADR-0001](./adr/0001-policy-compiler-not-runtime-middleware.md)
- A non-TypeScript DSL — see [ADR-0015](./adr/0015-typescript-as-dsl.md)
- A Go or Rust binary distribution — see [ADR-0017](./adr/0017-typescript-implementation.md)

## Milestones (Phase 1)

Tracked in the repo's todo system. High-level sequence:

1. Cleanup commit (Flowchestra-bootstrap residue) ✓
2. `docs/` + 17 ADRs ← *we are here*
3. Turborepo scaffold: `turbo.json`, `pnpm-workspace.yaml`, root `package.json`, `tsconfig.base.json`, `packages/*/package.json` skeletons
4. Core type primitives: `defineClaims` / `defineDbRoles` / `defineAppRoles` / `defineResources` / `defineResourceGrants` / `defineSchema`
5. Constructor + policy builders (`.model`, `.policy`, `.columnPrivileges`, `.polymorphic`, `.noPolicy`, `.rawSql`, `.todo`)
6. Emitters (RLS + column privileges)
7. Functional lifecycle in core: `compileToOps` / `compileToState` / `diffStates` / `applyOps` (forward-replay sidecars)
8. `planMigrate` / `runMigrate` in CLI (idempotent SQL + sidecar emission)
9. Importers (Prisma DMMF + Postgres pg_policies)
10. Testing extension (real-PG harness)
11. Lint + Flowchestra preset
12. 5 proof tables + E2E integration tests
