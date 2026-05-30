# Plan

## Vision

`prisma-guarddog` is a TypeScript policy compiler and verification harness for Prisma-backed Postgres applications. It emits Postgres RLS DDL, role grants, column privileges, sidecar migration metadata, and test scaffolds — all driven by policies authored in TypeScript and typed against the consumer's generated Prisma client.

## Current state

**Released:** `0.1.0-alpha.13` on GitHub Packages (`alpha.14` queued, lockstep across the 9 `@flowchestra/*` packages). The `0.1.0-alpha.x` line is internal-alpha; breaking changes are expected. Public npm distribution is the post-alpha goal.

**Verified:** 526 unit tests + 31 real-Postgres E2E scenarios pass. CI gates on type-check, lint, unit tests, and the E2E suite (Postgres service container) for every push and PR; Changesets drives the release flow on `main`.

**Where we are in the plan:** Phase 1 and Phase 1.5 are **complete**; Phase 2 is in progress.

---

## Phase 1 — Foundations *(complete)*

Schema-driven authoring, deterministic compile, idempotent emit, sidecar-replay state model.

### Delivered

#### Core (`@flowchestra/prisma-guarddog-core`)

- `defineClaims()`, `defineDbRoles()`, `defineAppRoles()`, `defineResources()`, `defineResourceGrants()`, `defineFunctions()`, `defineSchema()`
- `new Guarddog({...})` constructor with `.model()`, `.policy()`, `.columnPrivileges()`, `.polymorphic()`, `.noPolicy()`, `.rawSql()`, `.todo()` builders
- **Functional lifecycle** — `compileToOps`, `compileToState`, `diffStates`, `applyOps`: pure functions over an Op-union state, not instance methods ([ADR-0020](./adr/0020-functional-lifecycle-over-op-union.md))
- Pure typed AST output; no SQL emission in core

#### Emitters

- `@flowchestra/prisma-guarddog-emitter-postgres-rls` — `CREATE POLICY`, `ENABLE` / `FORCE ROW LEVEL SECURITY`
- `@flowchestra/prisma-guarddog-emitter-postgres-column-privileges` — column-level `GRANT` / `REVOKE`

#### Importers (scaffold-mode only, [ADR-0012](./adr/0012-scaffold-only-importer.md))

- `@flowchestra/prisma-guarddog-importer-prisma` — DMMF → coverage check + model column-type codegen
- `@flowchestra/prisma-guarddog-importer-postgres` — `pg_policies` + column privileges → TS scaffolds with `rawSql()` + `.todo()` + `noPolicy()` stubs

#### Testing

- `@flowchestra/prisma-guarddog-testing-postgres` — `withScenario`, `assertAllowed`, `assertDenied`, `assertVisibleRows`, `assertHiddenColumns`. Real Postgres only — no shims ([ADR-0013](./adr/0013-real-postgres-required-for-tests.md)).

#### Lint

- `@flowchestra/prisma-guarddog-lint` — every Prisma model must have `policy()`, `polymorphic()`, or `noPolicy()`. CI fails otherwise.

#### Preset

- `@flowchestra/prisma-guarddog-preset` — `createFlowchestraGuarddog({ prisma, claimsAccessor })` as the reference downstream preset.

#### CLI

- `prisma-guarddog` (unscoped binary name; package `@flowchestra/prisma-guarddog`) — `guarddog check`, `migrate`, `emit`, `diff`, `import` shipped.

#### Proof-of-API

- 7 representative models in `examples/flowchestra` covering every Phase 1 scenario: tenant-only, workspace + role, workbench cascade, nullable-workbench file, owner pattern, polymorphic discriminated-union, opted-out `noPolicy()`.

### Definition of done — met

- All Phase 1 packages publish via the Changesets pipeline (`@flowchestra` scope on GitHub Packages).
- Idempotent re-apply: `pg_policies` + `pg_roles` snapshot unchanged after a second `migration.sql` apply.
- E2E tests pass against real Postgres in CI.
- `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm build` all green at the workspace root.

---

## Phase 1.5 — Adoption + drift *(complete)*

Carved out as its own tier after the Flowchestra pilot proved that **the hard problem isn't authoring policies — it's adopting onto a database that already has them.** Postgres permissive policies OR together, so a leftover legacy policy silently widens access across the cutover window. Phase 1.5 closes that gap end-to-end.

### Delivered

- **Foreign-policy drift detection** ([ADR-0029](./adr/0029-handling-existing-rls-policies.md)) — every guarddog-emitted policy is stamped with an ownership comment (`prisma-guarddog:managed`) so `computePolicyDrift` can distinguish guarddog's policies from a consumer's foreign / legacy ones. Classifies as `foreign` (permissive ones widen — danger), `staleManaged` (guarddog-marked but no longer declared), `missing` (declared but not in the DB), and `acknowledged` (deliberately kept — see adopt). `guarddog drift --against <url>` reports it; `--exit-code` gates CI.

- **Interactive adoption triage** ([ADR-0030](./adr/0030-interactive-adoption-triage.md)) — `guarddog adopt --against <url>` walks every foreign policy and prompts for a disposition: `keep` (stamp `:ignore` so drift acknowledges it), `remove` (drop now), `edit` (scaffold `rawSql(<legacy>) + .todo()` to fold into `guarddog.ts`), `override` (scaffold a fresh `.todo()` stub, discard the legacy SQL), `skip` (leave alone, re-surface next run). Cuts adoption from "rewrite-everything-or-nothing" to per-policy.

- **User-declared policy names** ([ADR-0031](./adr/0031-user-declared-policy-names.md)) — `.named()` chained or `{ name }` per verb. Closes the additive cutover window: a typed replacement under a legacy name renders `DROP POLICY IF EXISTS <legacy>; CREATE POLICY <legacy> …` and upgrades the legacy policy **in place, atomically** — no widening from the OR'd permissive coexistence the auto-gen names would otherwise create. Pairs naturally with `adopt --edit`. Lint warns on declared names so authors converge back on the convention once adoption is complete.

- **Restrictive policies + isolation sugar** ([ADR-0032](./adr/0032-restrictive-policy-support.md)) — `.restrictivePolicy(role).forAll(fn)` primitive plus `.isolation(fn)` model-level sugar (auto-name `<table>_isolation`, `AS RESTRICTIVE FOR ALL TO public`). Restrictive policies AND with all other policies, so the tenant + soft-delete floor is **structurally enforced**, not author-discipline-dependent. A future permissive break-glass cannot widen around the floor. Drift gains a `restrictivenessMismatch` classification reporting permissive ↔ restrictive disagreement on the same `(table, name)`.

### Why this is its own tier

Phase 1 designed for greenfield: write a schema, emit a migration, apply it. Phase 1.5 hardens that for brownfield: cross over to an existing database without leaks, transitionally name policies for atomic in-place swaps, and express the HARD-floor / SOFT-access split structurally. The four ADRs are interlocking — `adopt --edit` scaffolds `rawSql(<legacy>) + .named(<legacy>)`; restrictive `isolation(fn, { name: 'tenant_isolation' })` upgrades a hand-written restrictive in place; drift catches every mismatch the path would otherwise paper over.

### Carry-over to later phases

- **Column-privilege base-table REVOKE prelude** — declared in lint as `column-privilege-unenforced` ([ADR-0027](./adr/0027-column-privilege-enforcement-gap.md), [issue #2](https://github.com/Flowchestra/prisma-guarddog/issues/2)). The lint stops it from failing silently; the enforcement primitive lands in Phase 2 alongside the broader privileges work.

---

## Phase 2 — Provider + visibility extensions *(in progress)*

The provider-and-visibility tier — what brownfield consumers ask for once they've adopted Phase 1.5 and gone live.

- **FDW table support** — emitter handles foreign tables with no native tenant column; policies join through the FDW (`@flowchestra/prisma-guarddog-emitter-fdw`).
- **Row-conditional field masking** — `.masks()` / `.projection()` builders; emitted via generated secure views or projection functions ([ADR-0004](./adr/0004-column-privileges-vs-row-conditional-masking.md)).
- **Column-privilege base-table REVOKE prelude** — promotes the existing `column-privilege-unenforced` lint into actual enforcement ([issue #2](https://github.com/Flowchestra/prisma-guarddog/issues/2)).
- **Supabase-specific importer** — pulls policies via Supabase REST/dashboard rather than direct `pg_policies` (`@flowchestra/prisma-guarddog-importer-supabase`).

### Already shipped (annotated for history)

These were originally scoped to Phase 2 but landed earlier as alpha drops:

- **Table-backed `resourceGrants` source** — shipped in `0.1.0-alpha.2` via `defineResourceGrants({ source: 'table', tables: {...}, fallbackTable: {...} })`. Supports per-resource grant tables + polymorphic fallback ([ADR-0021](./adr/0021-table-backed-resource-grants.md)).
- **Rank-based + group-disjunctive grant tables** — shipped in `0.1.0-alpha.3` (issues [#5](https://github.com/Flowchestra/prisma-guarddog/issues/5) / [#6](https://github.com/Flowchestra/prisma-guarddog/issues/6)): `roleColumn` + `roleHierarchy` rank semantics ([ADR-0022](./adr/0022-rank-based-grant-tables.md)) and `principalUserColumn` / `principalGroupColumn` / `groupMemberTable` user-OR-group resolution ([ADR-0023](./adr/0023-grant-principal-disjunction.md)). Plus CLI-threaded render overrides ([ADR-0024](./adr/0024-config-threaded-render-overrides.md)).
- **`hasGrant` per-call table hint** — shipped in `0.1.0-alpha.4` (issue [#11](https://github.com/Flowchestra/prisma-guarddog/issues/11), [ADR-0025](./adr/0025-hasgrant-per-call-table-hint.md)): `p.hasGrant(action, col('id'), { table })` for own-row grant checks. Type-safe autocomplete on the hint key shipped in `0.1.0-alpha.5` (issue [#12](https://github.com/Flowchestra/prisma-guarddog/issues/12)).
- **guarddog-managed SQL functions** — shipped in `0.1.0-alpha.6` (issue [#15](https://github.com/Flowchestra/prisma-guarddog/issues/15), [ADR-0026](./adr/0026-managed-sql-functions.md)): `defineFunctions({ schema, fns })` emits + signature-diffs `CREATE OR REPLACE FUNCTION` DDL, `CREATE SCHEMA`, and `GRANT EXECUTE`; `p.fn(name, ...args)` calls them from policies.
- **Typed model + column references** — shipped in `0.1.0-alpha.7` (issue [#16](https://github.com/Flowchestra/prisma-guarddog/issues/16), [ADR-0028](./adr/0028-typed-model-and-column-references.md)): `guard.model(...)` and `p.col(...)` autocomplete and type-check against the Prisma DMMF.

---

## Phase 3 — Identity provider integration

- **WorkOS FGA bridge** — `@flowchestra/prisma-guarddog-fga-workos`
- Translates WorkOS actions + composable roles → guarddog `appRoles` and grant predicates
- Emitted policies call `app.*` functions (Phase 2 + Phase 3) that resolve FGA relationships at query time

---

## Out of scope *(entirely, not "Phase 4")*

- **Warehouse / datalake coverage** — different access model, different security primitives.
- **Runtime enforcement / Prisma client extension** — see [ADR-0001](./adr/0001-policy-compiler-not-runtime-middleware.md). All enforcement happens in Postgres.
- **A non-TypeScript DSL** — see [ADR-0015](./adr/0015-typescript-as-dsl.md).
- **A Go or Rust binary distribution** — see [ADR-0017](./adr/0017-typescript-implementation.md).
