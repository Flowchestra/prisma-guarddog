---
'@flowchestra/prisma-guarddog': minor
---

`guarddog adopt` — interactive, per-policy triage of the RLS policies already in a database (ADR-0030). Builds on the drift engine (ADR-0029) to turn adoption from all-or-nothing into a guided, auditable decision.

For each **foreign** policy on a guarddog-managed table, pick a disposition:

- **keep** — deliberately managed outside guarddog. Stamps `COMMENT ON POLICY … IS 'prisma-guarddog:ignore'`; `drift` then reports it as *acknowledged* (not foreign) and `migrate --drop-unmanaged` never drops it. The decision lives in the catalog and travels with the database — no config file.
- **remove** — `DROP POLICY` now.
- **edit** — scaffold the policy as `rawSql(<legacy>) + .todo()` to refine into a typed predicate.
- **override** — scaffold a fresh-author `.todo()` stub (legacy SQL discarded).
- **skip** — decide later.

```sh
guarddog adopt --against "$DATABASE_URL"            # interactive TTY prompt
guarddog adopt --against "$DATABASE_URL" --out adopted.ts
```

The decision logic is a pure `planAdoption` (keep-comments / drop ops / scaffold), with the prompt as a thin injectable shell — so it's unit-tested, and a docker e2e proves the keep/remove/edit dispositions land against real Postgres. `computePolicyDrift` gains an `acknowledged` classification for `:ignore`-marked policies. Conservative: `adopt` only writes the keep-marks and drops you confirm per policy, scoped to foreign policies on managed tables.
