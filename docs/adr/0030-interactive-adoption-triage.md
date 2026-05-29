# 0030 — Interactive adoption triage (`guarddog adopt`)

**Status:** Accepted (implemented)
**Date:** 2026-05-29

## Context

ADR-0029 gave guarddog the primitives to handle a database that already has hand-written RLS: an ownership marker, drift detection (`guarddog drift --against`), and a blunt cutover (`migrate --drop-unmanaged`). But adoption onto a real system is rarely "drop everything foreign." Some legacy policies should be **dropped**, some **kept** as-is (deliberately managed outside guarddog), and some **brought into** guarddog — either rewritten from scratch or refined from their existing SQL.

`guarddog import` already scaffolds *every* policy as `rawSql() + .todo()` non-interactively (ADR-0012) — all-or-nothing, no per-policy judgment. What's missing is a guided, per-policy triage that records the operator's decision durably so `drift` and the cutover honor it.

## Decision

Add `guarddog adopt --against <url>` — an interactive, per-policy triage over the **foreign** policies on guarddog-managed tables (the ones `computePolicyDrift` flags). For each, the operator picks a disposition:

| Disposition | Meaning | Mechanism |
| --- | --- | --- |
| **keep** | deliberately managed outside guarddog | stamp `COMMENT ON POLICY … IS 'prisma-guarddog:ignore'` — drift no longer flags it, cutover never drops it |
| **remove** | a latent bug / superseded | emit `DROP POLICY` now |
| **edit** | bring into guarddog, starting from its SQL | scaffold `rawSql(<legacy>) + .todo('replace with a typed predicate')` |
| **override** | bring into guarddog, authored fresh | scaffold a `.todo('author a typed replacement for <name>')` stub |
| **skip** | decide later | no change; re-appears next run |

**Persistence lives in the catalog, not config.** `keep` records the decision as a second ownership marker (`prisma-guarddog:ignore`) on the policy itself, alongside the `:managed` marker from ADR-0029. The decision travels with the database and needs no config file. `computePolicyDrift` gains a third classification: a non-declared policy commented `:ignore` is **acknowledged** (reported for transparency, never `foreign`, never in `driftToDropOps`).

**Outputs.** An `adopt` session writes to the DB only for `keep` (the ignore comment) and `remove` (the drop). `edit`/`override` produce a **scaffold snippet** (printed, or `--out <file>`) the operator folds into `guarddog.ts`; once the typed policy is declared and applied, guarddog owns it (`:managed`) and the legacy is dropped via `migrate --drop-unmanaged`. So the four dispositions collapse to three mechanisms: ignore-marker, drop, scaffold.

**Testable core.** The disposition→effect mapping is a pure function `planAdoption(foreign, dispositions) → { scaffold, keepComments, dropOps }`. The interactive prompt is a thin shell: `adopt` takes an injectable `decide(policy) => disposition`, defaulting to a `readline` TTY prompt (no new dependency). Tests and CI supply a deterministic `decide`; a `--plan <json>` flag drives it non-interactively.

## Consequences

**Positive**
- Turns adoption from all-or-nothing into a guided, auditable, per-policy decision — the realistic onboarding path.
- Decisions are durable and travel with the database (catalog comments), with no new config surface; `drift`/cutover automatically honor `keep`.
- Reuses ADR-0029's drift engine and ADR-0012's scaffold codegen; the new logic is a pure planner + a thin readline shell, both small.
- `edit`/`override` keep the consumer on the typed-predicate path (scaffold → refine), not stuck on `rawSql`.

**Negative**
- A `keep` ignore-marker is advisory (a manual `COMMENT` strip un-acknowledges it). Same trade-off as the `:managed` marker — acceptable, and the inverse is safe (un-acknowledging only re-surfaces it in drift).
- Interactive prompts are inherently harder to test than pure code; mitigated by factoring the decision into `planAdoption` and injecting `decide`.
- `adopt` writes to the DB (ignore comments, drops). It only touches foreign policies on managed tables, only with explicit per-policy confirmation, and `remove`/`keep` are exactly what the prior `drift` report showed — but it is no longer read-only like `drift`.

## Alternatives considered

- **Config-file ignore-list for `keep`.** Works, but adds config surface and the decision lives apart from the DB it describes. The catalog comment is self-describing and travels with the data. Rejected.
- **Fold triage into `guarddog import`.** `import` is the non-interactive all-policies scaffold (ADR-0012); overloading it with interactive per-policy DB-writing dispositions muddies a read-only codegen tool. A distinct `adopt` keeps each command single-purpose.
- **Auto-classify (heuristically decide keep/drop).** Too risky for a security primitive — a wrong auto-drop or auto-keep is a silent access change. Triage is deliberately operator-driven.

## References

- [ADR-0029 — Handling existing (foreign) RLS policies](./0029-handling-existing-rls-policies.md) — the drift engine + ownership marker this builds on
- [ADR-0012 — Scaffold-only importer](./0012-scaffold-only-importer.md) — the `rawSql() + .todo()` scaffold reused for `edit`/`override`
- [`packages/cli/src/drift.ts`](../../packages/cli/src/drift.ts) — `computePolicyDrift` (acknowledged classification), `planAdoption`
- [`packages/cli/src/commands/adopt.ts`](../../packages/cli/src/commands/adopt.ts) — the interactive command
