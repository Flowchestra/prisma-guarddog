# Plan

## Vision

`prisma-guarddog` is a TypeScript policy compiler and verification harness for Prisma-backed Postgres applications. It emits Postgres RLS DDL, role grants, column privileges, sidecar migration metadata, and test scaffolds — all driven by policies authored in TypeScript and typed against the consumer's generated Prisma client.

## Phases

### Phase 1 — Foundations (in progress)

Scope is **locked**. The exit criteria below are deliberately narrow; do not propose adding to Phase 1.

#### Deliverables

**Core (`@prisma-guarddog/core`)**

- `defineClaims()`, `defineDbRoles()`, `defineBusinessRoles()`, `resources()`
- `new Guarddog({...})` constructor with `.model()`, `.policy()`, `.columnPrivileges()`, `.polymorphic()`, `.noPolicy()`, `.rawSql()` builders
- `.emit()`, `.diff()`, `.migrate()` lifecycle methods
- Pure typed AST output; no SQL emission in core

**Emitters**

- `@prisma-guarddog/emitter-postgres-rls` — `CREATE POLICY`, `ENABLE/FORCE ROW LEVEL SECURITY`, table-level `REVOKE`
- `@prisma-guarddog/emitter-postgres-column-privileges` — column `GRANT`/`REVOKE`

**Importers (scaffold-mode only)**

- `@prisma-guarddog/importer-prisma` — DMMF → coverage check + model stubs
- `@prisma-guarddog/importer-postgres` — `pg_policies` + column privileges → TS scaffolds with `rawSql()` + `.todo()` + `noPolicy()` stubs

**Testing**

- `@prisma-guarddog/testing-postgres` — `withDbRole`, `withClaims`, `assertAllowed`, `assertDenied`, `assertVisibleRows`, `assertHiddenColumns`. Real Postgres only (no shims).

**Lint**

- `@prisma-guarddog/lint` — every Prisma model must have `policy()`, `noPolicy()`, or `importedRawPolicy()`. CI fails otherwise.

**Preset**

- `@prisma-guarddog/preset-flowchestra` — `createFlowchestraGuarddog({ prisma, claimsAccessor })`

**CLI**

- `prisma-guarddog` (unscoped) — `guarddog emit / diff / migrate / import`

**Proof-of-API**

- 5 representative tables authored against the Flowchestra schema, exercising:
  1. Tenant-scoped only
  2. Workspace-scoped with role-gated mutations
  3. Workbench-scoped with nullable `workbenchId`
  4. Column-level masking case (column privileges path)
  5. Polymorphic grant case (discriminated-union table)
- End-to-end integration tests for each, using `@prisma-guarddog/testing-postgres`

#### Definition of done

- All Phase 1 packages publish dry-run cleanly to npm
- 5 proof tables emit idempotent SQL that re-applies as no-op
- E2E tests pass against real Postgres in CI
- `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm build` all pass at the workspace root
- ADRs 0001–0017 merged before any Phase 1 implementation lands

### Phase 2 — Provider and visibility extensions

- **FDW table support** — emitter handles foreign tables with no native tenant column; policies join through the FDW (`@prisma-guarddog/emitter-fdw`)
- **Row-conditional field masking** — `.masks()` / `.projection()` builders; emitted via generated secure views or projection functions
- **Supabase-specific importer** — pulls policies via Supabase REST/dashboard rather than direct `pg_policies` (`@prisma-guarddog/importer-supabase`)

### Phase 3 — Identity provider integration

- **WorkOS FGA bridge** — `@prisma-guarddog/fga-workos`
- Translates WorkOS actions + composable roles → guarddog `businessRoles` and grant predicates
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
4. Core type primitives: `defineClaims` / `defineDbRoles` / `defineBusinessRoles` / `resources`
5. Constructor + policy builders (`.model`, `.policy`, `.columnPrivileges`, `.polymorphic`, `.noPolicy`, `.rawSql`)
6. Emitters (RLS + column privileges)
7. `.emit()` / `.diff()` lifecycle in core (forward-replay sidecars)
8. `.migrate()` in CLI (idempotent SQL + sidecar emission)
9. Importers (Prisma DMMF + Postgres pg_policies)
10. Testing extension (real-PG harness)
11. Lint + Flowchestra preset
12. 5 proof tables + E2E integration tests
