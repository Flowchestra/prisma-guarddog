# 0007 — Forward-replay state derivation

**Status:** Accepted
**Date:** 2026-05-23

## Context

Computing the next migration requires knowing what's currently deployed. Given the decision in [ADR-0006](./0006-sidecar-migration-metadata.md) to avoid a central manifest or state snapshot file, there must be some mechanism to answer "what's the current state?"

Options:

- **Read the live database** via `pg_policies` and `information_schema.column_privileges`. Source of truth is what's actually deployed. But: requires a DB connection at every `guarddog migrate`/`diff`, and surfaces production drift unpredictably during local dev.
- **Forward-replay sidecar ops in `_prisma_migrations` ledger order.** State is the result of applying every migration's ops in order. No DB connection needed for diff computation.

Forward-replay aligns with how Prisma itself treats schema: `schema.prisma` plus the migration history is the source of truth; the live database is verified to match, not relied on to define state.

## Decision

Current deployed policy state is **derived by forward-replaying all `guarddog.json` sidecars** in `_prisma_migrations` ledger order. There is no separate state file anywhere.

The flow for `guarddog migrate`:

1. Read TS policy definitions → produce **target state** (canonical, sorted).
2. Read every `guarddog.json` from migrations applied per `_prisma_migrations` → forward-replay ops to produce **current state**.
3. Compute diff: additions, removals, modifications.
4. Emit new migration directory: `migration.sql` (idempotent DDL) + `guarddog.json` (ops log for the diff).

The live database is **not** queried during diff computation. It is, however, verified to match the replayed state during `guarddog check` (CI-time consistency check).

## Consequences

**Positive:**

- Diff computation is hermetic — no DB connection required.
- Aligns with Prisma's own "schema + migration history = source of truth" model.
- Replay is O(migrations) per command invocation; trivially fast even at hundreds of migrations.
- Local dev and CI behavior is identical regardless of which database the user is pointed at.

**Negative:**

- Drift between replayed state and live database is possible if a human manually altered Postgres. `guarddog check` exists to detect this.
- Replaying ops requires a small evaluator inside the core package (essentially: apply each op to a Map; final Map is current state). Modest complexity, but it's code that has to be maintained.

## Alternatives considered

- **Live-database introspection at diff time:** rejected — couples diff to a DB connection; surfaces real-world drift in a way that's confusing during local development.
- **Cache the replayed state in a snapshot file for speed:** rejected — that's a central manifest by another name (see [ADR-0006](./0006-sidecar-migration-metadata.md)).
- **Store full state in each sidecar instead of just ops:** rejected — large duplication across migrations; ops log is smaller and easier to review.

## References

- [ADR-0006 — Sidecar migration metadata](./0006-sidecar-migration-metadata.md)
- [ADR-0008 — Idempotent DDL emission](./0008-idempotent-ddl-emission.md)
