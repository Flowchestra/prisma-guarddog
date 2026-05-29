---
'@flowchestra/prisma-guarddog-lint': minor
---

Add a `column-privilege-unenforced` coverage-lint warning (#2, [ADR-0027](../docs/adr/0027-column-privilege-enforcement-gap.md)).

`.columnPrivileges()` emits only the column-level `GRANT`s — it does **not** restrict access on its own. A column `GRANT` doesn't override a table-level `GRANT` (effective access is `table-level OR column-level`), so a pre-existing table-wide grant or a PUBLIC default silently supersedes the "restriction." The compiled SQL looks complete; only an e2e test reveals the column is still readable.

`lintCoverage` now emits a non-failing `warning` for every model carrying `columnPrivileges`, explaining the gap and the interim requirement (withhold table-level privileges / grant only the allowed columns until guarddog manages base-table grants). `guarddog check --lint` and editor extensions surface it. Changes no emitted SQL — zero blast radius.

The full fix (guarddog owning base-table grant posture + the table column universe via DMMF, so it can emit `REVOKE`-table + per-column re-`GRANT`) is scoped in ADR-0027 and deferred to its own release.
