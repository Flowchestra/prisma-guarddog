# 0014 — Phase scope boundaries

**Status:** Accepted
**Date:** 2026-05-23

## Context

The space of "policy authoring for Prisma + Postgres" is large. Without explicit scope boundaries, every conversation eventually wanders into Supabase-specific concerns, FDW tables, warehouse access models, WorkOS FGA integration, runtime authorization, and so on. Scope creep at this stage compromises Phase 1 delivery.

## Decision

Three phases, with hard boundaries. Items outside the listed phases are either deferred explicitly or **out of scope entirely**.

### Phase 1 — Foundations

- Core types: `defineClaims`, `defineDbRoles`, `defineAppRoles`, `resources`
- `Guarddog` constructor with `.model()`, `.policy()`, `.columnPrivileges()`, `.polymorphic()`, `.noPolicy()`, `.rawSql()` builders
- Explicit `USING` / `WITH CHECK` split (no inference)
- `.emit()` / `.diff()` / `.migrate()` lifecycle
- Postgres RLS emitter (CREATE POLICY, ENABLE/FORCE RLS, table-level REVOKE)
- Postgres column privileges emitter (column GRANT/REVOKE)
- Scaffold-mode importer (Prisma DMMF + `pg_policies` + column privileges → TS stubs)
- Real-Postgres testing harness (`withDbRole`, `withClaims`, assertions)
- Lint extension (coverage check)
- Flowchestra preset
- CLI: `guarddog emit / diff / migrate / import`
- 5 proof-of-API tables in `examples/`

### Phase 2 — Provider and visibility extensions

- FDW table support (foreign-table policies; no native tenant column)
- Row-conditional field masking (`.masks()` / `.projection()`) via generated secure views or projection functions
- Supabase-specific importer (pulls via Supabase REST/dashboard rather than direct catalog access)
- Additional dialect emitters as demand justifies

### Phase 3 — Identity provider integration

- WorkOS FGA bridge (`@prisma-guarddog/fga-workos`)
- Translates WorkOS actions + composable roles → guarddog `appRoles` and grant predicates
- Emits policies that call `app.*` functions resolving FGA relationships at query time

### Out of scope entirely

These are not "Phase 4." They are not on the roadmap.

- Warehouse / datalake coverage — different access models, different security primitives
- Runtime enforcement / Prisma client extension (see [ADR-0001](./0001-policy-compiler-not-runtime-middleware.md))
- A non-TypeScript DSL (see [ADR-0015](./0015-typescript-as-dsl.md))
- A Go or Rust binary distribution (see [ADR-0017](./0017-typescript-implementation.md))
- A central manifest file / schema snapshot (see [ADR-0006](./0006-sidecar-migration-metadata.md), [ADR-0007](./0007-forward-replay-state-derivation.md))
- Magic `USING`/`WITH CHECK` inference (see [ADR-0005](./0005-explicit-using-and-with-check.md))
- Reverse-engineering business intent in the importer (see [ADR-0012](./0012-scaffold-only-importer.md))
- In-memory test shims (see [ADR-0013](./0013-real-postgres-required-for-tests.md))

## Consequences

**Positive:**

- Conversations about scope have a clear referee. "That's Phase 2" is a one-line answer.
- Phase 1 delivery doesn't slip from adjacent-but-distinct concerns being smuggled in.
- "Out of scope entirely" prevents litigation of decisions already made.

**Negative:**

- Hard boundaries can be wrong. If Phase 1 reveals that something filed under Phase 2 is actually load-bearing for the core, this ADR (or a successor) needs to be revised explicitly.

## Alternatives considered

- **Soft scoping ("ideally Phase 1, but flexible"):** rejected — produces the slippage being avoided.
- **No phasing; build everything at once:** rejected — Phase 1 is already a multi-week effort. Anything more guarantees no shipped value.

## References

- [PLAN.md](../PLAN.md)
- [ADR-0001 — Policy compiler, not runtime middleware](./0001-policy-compiler-not-runtime-middleware.md)
- [ADR-0017 — TypeScript implementation; no compiled binary](./0017-typescript-implementation.md)
