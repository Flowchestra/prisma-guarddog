# 0008 — Idempotent DDL emission

**Status:** Accepted
**Date:** 2026-05-23

## Context

Migrations should be safe to re-run. A migration that errors halfway through, gets retried in CI, or is replayed on a fresh database against the same `_prisma_migrations` ledger must produce the same end state without errors.

Postgres' DDL is a mixed bag for idempotency:

- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` — natively idempotent.
- `ALTER TABLE ... FORCE ROW LEVEL SECURITY` — natively idempotent.
- `GRANT ... ON ... TO ...` — natively idempotent.
- `REVOKE ... FROM ...` — natively idempotent (no-op if no privilege existed).
- `CREATE POLICY ...` — **not idempotent.** Postgres has no `CREATE POLICY IF NOT EXISTS`. Re-running fails with `policy "X" for table "Y" already exists`.
- `CREATE ROLE ...` — not idempotent. Re-running fails with `role "X" already exists`.

## Decision

All DDL emitted by guarddog must be idempotent. The strategies:

| DDL                          | Idempotency strategy                                                     |
| ---------------------------- | ------------------------------------------------------------------------ |
| `ENABLE ROW LEVEL SECURITY`  | Native — emit as-is.                                                     |
| `FORCE ROW LEVEL SECURITY`   | Native — emit as-is.                                                     |
| `CREATE POLICY x ON t ...`   | Emit `DROP POLICY IF EXISTS x ON t;` immediately followed by `CREATE POLICY x ON t ...`. Both run inside the migration's transaction; atomic from the DB's point of view. |
| `GRANT` / `REVOKE` (column)  | Native — emit as-is.                                                     |
| `CREATE ROLE x`              | Emit `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='x') THEN CREATE ROLE x ...; END IF; END $$;` |

The drop-create pair for policies is the canonical pattern — guarddog never emits a bare `CREATE POLICY`.

## Consequences

**Positive:**

- Any migration is safe to re-run against a database that already has the migration applied (or partially applied). The end state is the same.
- CI retries, partial failures, and `prisma migrate deploy` reruns are all safe.
- The "what changed" question is answered by `guarddog.json` sidecars, not by inspecting DDL diffs.

**Negative:**

- Emitted SQL is slightly more verbose than the minimal form.
- A re-applied policy briefly does not exist between the `DROP` and `CREATE` — within the transaction this is invisible to other sessions, but it's worth being explicit that we rely on the migration running inside Prisma's transaction wrapper.

## Alternatives considered

- **Emit raw `CREATE POLICY`; rely on `_prisma_migrations` to skip applied migrations:** rejected — does not survive partial application or manual `psql` replays.
- **Use `DROP POLICY IF EXISTS` only on re-runs, detected by querying first:** rejected — adds runtime introspection and breaks the hermetic emit model.
- **Wrap each statement in a `DO $$ ... $$` block that checks `pg_policies` first:** rejected as gratuitously complex when `DROP IF EXISTS` + `CREATE` is one line and equivalent in effect.

## References

- [ADR-0005 — Explicit USING and WITH CHECK](./0005-explicit-using-and-with-check.md)
- [ADR-0006 — Sidecar migration metadata](./0006-sidecar-migration-metadata.md)
- [ADR-0010 — Migrations colocate with Prisma](./0010-migrations-colocate-with-prisma.md)
