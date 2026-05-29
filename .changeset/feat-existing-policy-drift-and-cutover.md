---
'@flowchestra/prisma-guarddog': minor
'@flowchestra/prisma-guarddog-importer-postgres': minor
---

Handle pre-existing (foreign) RLS policies during adoption (ADR-0029). guarddog now detects, reports, and can cut over the hand-written policies already in a consumer's database — closing the silent hazard where a legacy permissive policy ORs with guarddog's and widens access (e.g. a `FOR ALL` policy leaking soft-deleted rows survives the migration).

- **Ownership marker** — every emitted `CREATE POLICY` is stamped with `COMMENT ON POLICY … IS 'prisma-guarddog:managed'`, the durable catalog record drift detection reads to tell guarddog's policies from foreign ones.
- **`guarddog drift --against <url>`** — compares the declared schema against the live database and reports, scoped to guarddog-managed tables: **foreign** policies (a consumer's own; permissive ones flagged as access-wideners), **stale-managed** (guarddog-marked but no longer declared), and **missing** (declared, not yet applied). `--exit-code` gates CI.
- **`guarddog migrate --drop-unmanaged`** — opt-in cutover: reads the live inventory and prepends `DROP POLICY` for foreign/stale policies on managed tables, so the migration removes legacy policies before creating guarddog's. Default `migrate` is unchanged and never auto-drops a foreign policy.
- **`readPolicyInventory`** (importer-postgres) — reads the live policy inventory (identity + permissive flag + ownership comment) from the `pg_policy` catalog.

Conservative by default: the DB-touching paths (`--against`, `--drop-unmanaged`) are opt-in; nothing changes for existing users. Covered by unit tests + a docker e2e proving the legacy-leak → drift-flag → cutover → leak-gone flow against real Postgres.
