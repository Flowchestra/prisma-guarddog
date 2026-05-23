# 0001 — Policy compiler, not runtime middleware

**Status:** Accepted
**Date:** 2026-05-23

## Context

Several existing tools target the same general problem space — declaring authorization rules for Prisma-backed Postgres applications — but they sit at very different layers of the stack:

- **App-layer enforcement** (ZenStack): policy expressions evaluated inside a wrapped Prisma client. The database itself has no policies; bypassing the wrapper bypasses security.
- **Runtime middleware / WHERE injection** (prisma-rls): mutates queries before they reach the database. DB-agnostic, but security depends entirely on the middleware being in the call path.
- **Hybrid client extensions** (Yates, official Prisma example): set Postgres session variables per transaction so DB-side policies can read them. Some enforcement is in Postgres; some is in JS.
- **Pure DB-side enforcement** (hand-written `CREATE POLICY` migrations): real RLS, applied by Postgres on every query regardless of caller. Defense-in-depth survives ORM bypass, raw SQL, replication consumers, and future non-Node clients.

For a multi-tenant application with sensitive data and a mixed access landscape (Prisma client, raw SQL, FDW consumers, future services), the only enforcement layer that holds across all those paths is the database itself.

## Decision

`prisma-guarddog` is a **policy compiler and verification harness**. It emits Postgres RLS DDL, role grants, column privileges, sidecar migration metadata, and test scaffolds — and stops there. All enforcement happens inside Postgres.

It is **not**:

- A runtime authorization framework
- A Prisma client extension
- A query-rewriting middleware
- A generic Fine-Grained Authorization (FGA) platform

## Consequences

**Positive:**

- Defense-in-depth: enforcement survives ORM bypass, raw SQL paths, future polyglot consumers, and replication.
- Zero runtime overhead from guarddog itself — once migrations are applied, the consumer's Prisma client is untouched.
- The package can be a build-time-only dependency. No production runtime footprint.
- Testing is honest: the verification harness exercises the actual Postgres role + session-var path, not a JS simulation.

**Negative:**

- Authoring complexity sits in TypeScript but evaluation happens in Postgres. Debuggability across that boundary requires care (the test harness exists partly to address this).
- Cannot enforce app-level concerns that have no SQL representation (e.g., rate limits, anomaly detection). Out of scope by design.
- Migration-time tooling, not runtime tooling. Users wanting "block this query right now" need a different tool.

## Alternatives considered

- **App-layer enforcement (ZenStack-style):** rejected because it doesn't survive ORM bypass and adds runtime overhead. The whole point of RLS is that the database enforces, regardless of caller.
- **Hybrid extension (Yates-style):** rejected as a primary model because the JS layer becomes load-bearing for correctness. Guarddog leaves the JS layer to Prisma; the database is the security boundary.
- **Runtime WHERE injection (prisma-rls-style):** rejected because it isn't actually RLS. It's a middleware that adds filters in Node — bypassed by any raw SQL.

## References

- [ADR-0002 — Evaluated and rejected alternatives](./0002-evaluated-and-rejected-alternatives.md)
- [ADR-0013 — Real Postgres required for tests](./0013-real-postgres-required-for-tests.md)
- [ADR-0014 — Phase scope boundaries](./0014-phase-scope-boundaries.md)
