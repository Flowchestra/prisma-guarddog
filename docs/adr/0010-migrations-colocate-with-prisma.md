# 0010 — Migrations colocate with Prisma

**Status:** Accepted
**Date:** 2026-05-23

## Context

Guarddog generates SQL migrations to apply policy changes. Several questions follow:

- Where do the migrations live?
- Who runs them?
- How are they tracked as applied/unapplied?
- How do they interact with `prisma migrate dev` and `prisma migrate deploy`?

Two main options:

- **Separate migration runner / directory:** guarddog owns its own ledger (`guarddog_migrations` table) and migration directory (`prisma/guarddog-migrations/` or `migrations/guarddog/`). Users run `guarddog migrate apply` in addition to Prisma's migrations.
- **Colocate with Prisma migrations:** generated SQL lives in `prisma/migrations/<timestamp>_<name>/migration.sql`. Prisma's existing apply flow (`prisma migrate deploy`, `prisma migrate dev`) runs guarddog migrations as part of its normal operation. The `_prisma_migrations` ledger is the single source of truth for "applied vs. pending."

## Decision

Colocate. Generated migrations are written to `prisma/migrations/<timestamp>_<name>/migration.sql` with a `guarddog.json` sidecar in the same directory. Prisma's standard apply flow runs them. The `_prisma_migrations` ledger is the only application ledger; guarddog does not maintain its own.

```
prisma/migrations/
  20260523120000_init_workbench_policies/
    migration.sql                ← Prisma applies this
    guarddog.json                ← guarddog's metadata
  20260524093000_add_users_table/  ← Prisma-only migration; no sidecar
    migration.sql
```

## Consequences

**Positive:**

- Users don't run a separate migration command. `pnpm db:migrate` (or `prisma migrate deploy`) applies everything.
- One ledger to reason about. No risk of guarddog's ledger drifting from Prisma's.
- Migration ordering is well-defined: by timestamp, like every other Prisma migration.
- Foreign migrations (Prisma-only, no sidecar) coexist transparently.

**Negative:**

- Guarddog migrations are visible in Prisma's migration directory, which may surprise users expecting it to contain only Prisma's own DDL. Naming convention (`<timestamp>_<policy-related-name>`) mitigates this.
- We are coupled to Prisma's migration directory layout. If Prisma changes the layout in a future major version, guarddog needs to follow.

## Alternatives considered

- **Separate migration directory with own runner:** rejected — two ledgers, two commands, two chances for drift. The user has to remember to apply guarddog separately, and ordering across the two is undefined.
- **Apply directly via a JS client without going through `prisma migrate`:** rejected — we'd lose the audit trail, the `_prisma_migrations` ledger, and the transaction wrapping that Prisma provides.

## References

- [ADR-0006 — Sidecar migration metadata](./0006-sidecar-migration-metadata.md)
- [ADR-0008 — Idempotent DDL emission](./0008-idempotent-ddl-emission.md)
- [ADR-0009 — Config resolution order](./0009-config-resolution-order.md)
