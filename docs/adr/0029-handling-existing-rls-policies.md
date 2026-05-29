# 0029 — Handling existing (foreign) RLS policies

**Status:** Accepted (implemented)
**Date:** 2026-05-29

## Context

guarddog's lifecycle only knows the policies in its **declared state + sidecar history**. It has no notion of policies it *didn't* author. On any database that already has hand-written RLS — the common case when adopting guarddog onto a live system — this is a real hazard:

- guarddog emits policies with deterministic names (`<table>_<role>_<verb>`). A consumer's legacy policy has an arbitrary name (`workspaces_manager_write`). So guarddog's `DROP POLICY IF EXISTS <its-own-name>` never drops the legacy one.
- Postgres **permissive policies OR together**. The orphaned legacy policy stays in force and *widens* access — silently. A real instance: a legacy `FOR ALL` policy that lets a manager `SELECT` a soft-deleted row survives the cutover and keeps leaking, even though the new guarddog SELECT policy gates on `deleted_at IS NULL`.

The compiled migration *looks* complete; only an end-to-end check against the live catalog reveals the orphan. guarddog needs (1) a way to tell its policies from foreign ones, (2) a way to report the drift, and (3) a way to cut over.

## Decision

Three layers, conservative by default.

**1. Ownership marker.** Every `CREATE POLICY` guarddog emits is immediately followed by `COMMENT ON POLICY "<name>" ON "<table>" IS 'prisma-guarddog:managed';`. The comment is the durable ownership record in the catalog (`pg_description` on `pg_policy`), independent of the naming convention — so guarddog can always distinguish "mine" from "foreign," even across renames.

**2. Live inventory + drift detection.** A catalog reader (`readPolicyInventory`, in `importer-postgres`) lists every policy in a schema with its table, command, permissive flag, and ownership comment. A pure `computePolicyDrift(declared, live)` (in the CLI) compares guarddog's declared `State` against the live inventory and classifies, **scoped to managed tables** (tables guarddog enables RLS on):

- **foreign** — a live policy on a managed table that guarddog did not declare and is not marked guarddog-managed. If `permissive`, it's an **access-widening risk** (it ORs with guarddog's policies).
- **missing** — a policy guarddog declares that isn't in the live DB (not yet applied / drifted away).
- **stale-managed** — a guarddog-marked live policy guarddog no longer declares (a prior-run orphan; safe for guarddog to drop).

`guarddog check --against <database-url>` runs this and prints the report; `--exit-code` fails the command when drift exists (CI gate). Foreign permissive policies are reported as warnings with the OR-widening explanation.

**3. Cutover.** `guarddog migrate --drop-unmanaged` (opt-in) reads the live inventory and prepends `drop-policy` ops for every foreign / stale-managed policy on a managed table, so the generated migration removes the legacy policies *before* creating guarddog's. Default `migrate` is unchanged and **never** auto-drops a foreign policy — guarddog will not surprise-drop a policy a consumer deliberately kept outside it.

## Consequences

**Positive**
- Closes the silent adoption hazard: legacy orphans that OR-widen access are detectable (`check --against`) and removable (`migrate --drop-unmanaged`).
- The ownership marker makes "mine vs. foreign" robust and self-describing in the catalog — the missing primitive behind the cutover bug.
- Conservative default: no behavior change for existing users; the DB-touching paths are opt-in (`--against`, `--drop-unmanaged`).
- Reuses the existing `importer-postgres` catalog-reading layer and the `pg` peer dependency already used by the e2e harness.

**Negative**
- `check --against` and `migrate --drop-unmanaged` need DB connectivity (a URL + privileges to read `pg_policy`/`pg_description`); they're additive, not on the default path.
- The ownership comment is advisory — a consumer who manually strips policy comments would make guarddog's policies look foreign. Acceptable: stripping a guarddog comment is a deliberate act, and the declared-state name match is a second signal.
- `--drop-unmanaged` is a sharp tool. It's opt-in, scoped to managed tables, and the dropped set is exactly what `check --against` reports first, so the operator sees it before applying.

## Alternatives considered

- **Naming convention as the only ownership signal.** Fragile: legacy names never match, and a guarddog rename orphans silently. The explicit comment is robust; naming/declared-state is the cross-check.
- **Managed-table ownership (guarddog owns ALL policies on any table it touches; auto-drop foreign).** Secure-by-default but can drop a policy a consumer intentionally kept. Rejected as the default; available via `--drop-unmanaged`.
- **Interactive triage tool (keep/drop/override/edit per policy at import).** A good onboarding UX, but it needs the ownership marker + drift primitives underneath to be meaningful. Deferred; layers on top of this.

## References

- Issue context: the Flowchestra adoption sweep cutover (legacy `FOR ALL` soft-delete-leak policy surviving the migration)
- [ADR-0012 — Scaffold-only importer](./0012-scaffold-only-importer.md) — the `importer-postgres` catalog-reading layer this extends
- [ADR-0020 — Functional lifecycle over an Op union](./0020-functional-lifecycle-over-op-union.md) — drops flow as `drop-policy` ops
- [`packages/importer-postgres/src/db.ts`](../../packages/importer-postgres/src/db.ts) — `readPolicyInventory`
- [`packages/cli/src/drift.ts`](../../packages/cli/src/drift.ts) — `computePolicyDrift`
- [`packages/cli/src/render-ops.ts`](../../packages/cli/src/render-ops.ts) — ownership-marker emission
