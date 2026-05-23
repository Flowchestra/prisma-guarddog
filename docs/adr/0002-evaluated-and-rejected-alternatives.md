# 0002 — Evaluated and rejected alternatives

**Status:** Accepted
**Date:** 2026-05-23

## Context

Before building `prisma-guarddog`, we evaluated the existing landscape of tools that touch policy authoring, RLS enforcement, or migration generation for Prisma-backed Postgres. The goal was to avoid reinventing a working solution. The conclusion was that no existing tool covers the requirement set (TypeScript-typed policies against Prisma model fields, polymorphic grants, custom claim shape, column-level privileges, composable predicates, idempotent migration emission, scaffold-mode import).

## Decision

Build `prisma-guarddog`. Do not adopt, fork, or wrap any of the alternatives evaluated below as a foundation.

## Alternatives considered

### ZenStack

- **What it does:** Adds policy authoring to Prisma via a `@@allow`/`@@deny` DSL in a `.zmodel` file. Generates a Prisma client extension that enforces policies at the app layer.
- **Why rejected:** Enforcement is in the wrapped Prisma client, not in Postgres. Bypassing the wrapper bypasses security. The DSL is a separate language with its own tooling. No first-class output to Postgres RLS DDL. Source-available licensing.

### Yates (cerebruminc/yates)

- **What it does:** Generates Postgres RLS policies and PG roles from a Prisma-aware config. The closest existing project in spirit.
- **Why rejected:**
  - Prisma 4.x only — the upgrade path to Prisma 6+/7 is not maintained.
  - No column-level security primitive.
  - No polymorphic relations support.
  - No custom claim shape — hardcoded to `current_setting('user.id')` patterns.
  - No type-checked authoring against Prisma model field enums.
  - `AND`/`OR`/`NOT` in policy expressions force a raw-SQL fallback.
  - The predicate-composition limitation is structural; "fork and extend" would require rewriting the predicate model.

### Atlas (atlasgo.io)

- **What it does:** Composite schema (Prisma + raw `.sql`) → `atlas migrate diff` emits SQL migrations including RLS DDL.
- **Why rejected:** Policies are still hand-written `.sql`. Atlas handles diff + migration generation; it does not provide a policy authoring DSL. The diff feature is Atlas Pro (paid tier).

### Supabase declarative schemas

- **What it does:** Declarative `.sql` files in `supabase/schemas/` + `migra` diff → migrations.
- **Why rejected:** The Supabase docs **explicitly list** RLS policies and column privileges as outside the `migra` diff engine. Declarative schemas track tables, views, functions, types — not policies. The "declarative" approach does not extend to the surfaces we care about.

### Official Prisma RLS client extension

- **What it does:** A reference example showing how to set Postgres session variables (`set_config`) inside a transaction so DB-side policies can read claims.
- **Why rejected:** It is explicitly an example, not a product. The README states it is "not intended to be used in production environments." Policies are still authored separately in SQL migrations.

### prisma-rls (s1owjke/prisma-rls)

- **What it does:** App-layer WHERE-clause injection via a Prisma client extension. Database-agnostic (works on MySQL/SQLite/etc.).
- **Why rejected:** Not actually RLS — runs in Node, not Postgres. Different threat model; bypassed by any raw SQL. Solves a different problem.

## Consequences

- We own the maintenance of every layer: DSL, emitters, importers, testing harness, lint, CLI.
- We get exactly the abstractions we need for our threat model (polymorphic grants, custom WorkOS claim shape, column-level privileges, composable predicates, sidecar-based migration tracking).
- We cannot rely on community fixes to the tools above — but we also are not blocked by their limitations.

## References

- [ADR-0001 — Policy compiler, not runtime middleware](./0001-policy-compiler-not-runtime-middleware.md)
- [ADR-0015 — TypeScript as the DSL](./0015-typescript-as-dsl.md)
