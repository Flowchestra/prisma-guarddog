# 0027 — Column-privilege enforcement gap: lint now, base-table ownership later

**Status:** Accepted
**Date:** 2026-05-28

## Context

`.columnPrivileges({ col: { select: ['app_system'] } })` reads like it locks a column down to a role, but the emitter only emits the column-level `GRANT` — it never restricts anyone else (issue #2). The naive fix ("also emit `REVOKE SELECT(col) … FROM PUBLIC` and the other roles") was proposed but **does not work**, and a fix that *does* work has real blast radius. Both facts forced a decision about scope.

**Why a column-level REVOKE doesn't enforce.** In Postgres, effective access to a column is `has table-level privilege` **OR** `has column-level privilege on that column`. A `REVOKE SELECT(col) ON t FROM r` removes only the column-level grant; it does **not** touch a table-level `GRANT SELECT ON t TO r`. The issue's repro is exactly a table-wide grant, so the column REVOKE is a no-op against it. To actually restrict a column you must withhold the **table-level** SELECT and then grant SELECT on each *allowed* column individually.

**Why the working version has blast radius.**

1. **guarddog does not own base-table grants today.** The Op union has `grant-column` / `revoke-column` but no table-level privilege op; consumers issue `GRANT … ON t TO r` out-of-band (the flowchestra example does this in its e2e stitch step). Emitting a table-level `REVOKE` from core would silently strip access consumers manage themselves — a production hazard for the live 93-policy consumer.
2. **Core doesn't know the table's column universe.** `ColumnPrivilegeAst.columns` holds only the *declared* columns. To revoke table-level SELECT and keep the other columns readable, guarddog must re-grant every allowed column — which it can't enumerate in the compile path (no DMMF in core; only `importer-prisma` has it). Without the universe, a table-level revoke locks the consumer out of everything.
3. **Role inheritance defeats per-role REVOKE.** `app_system` inheriting `app_user` keeps the inherited privilege after a `REVOKE … FROM app_system`.
4. **Deny-state isn't in the lifecycle.** `revoke-column` is emitted by `diffStates` only when a previously-*tracked grant* disappears. "Deny the complement" is the absence of a grant — modeling it for forward-replay + idempotent diff is new `State` surface, not a one-line op.

The danger is that the gap **fails silently**: the compiled SQL looks complete; only an end-to-end test reveals the column is still readable.

## Decision

Split the response into an interim signal now and a designed fix later.

**Now (`@flowchestra/prisma-guarddog-lint`, alpha.6):** add a `column-privilege-unenforced` lint warning. Any model carrying `.columnPrivileges()` emits a non-failing warning explaining that guarddog emits only the column-level GRANTs, that a column GRANT does not restrict access on its own, and that the consumer must withhold table-level privileges (or grant only the allowed columns) until guarddog manages base-table grants. This converts the silent failure into a loud, actionable one with zero blast radius — it changes no emitted SQL.

**Later (deferred, separate ADR + release):** real enforcement. guarddog gains a base-table grant primitive (a new `grant-table` / `revoke-table` op pair through `compileToOps` → `diffStates`) and learns each restricted table's column universe (wired from the Prisma DMMF, which `importer-prisma` already exposes). Declaring `columnPrivileges({ col: { select: [R] } })` then compiles to: `REVOKE SELECT ON t FROM PUBLIC` + the complement roles, then `GRANT SELECT(<allowed columns>) ON t TO <roles>`. This is opt-in per table and must ship with a migration note — any consumer relying on guarddog *not* touching base-table grants will see generated REVOKEs.

## Consequences

**Positive**
- The dangerous part of #2 — silence — is fixed immediately and safely. A misleading primitive now announces its own limitation at lint/`check` time and in editor extensions.
- No emitted SQL changes; no risk to existing consumers; the warning is non-failing (`check` stays green) so it can't break CI on adoption.
- The hard problem (base-table ownership + column universe + deny-state) is named and scoped instead of patched with a fix that doesn't work.

**Negative**
- The enforcement gap itself survives until the deferred work lands; `.columnPrivileges()` still doesn't restrict access on its own. The warning mitigates but doesn't close it.
- A warning on *every* `columnPrivileges` model is noisy for consumers who already write a correct base-table prelude (e.g. the flowchestra example). Acceptable for an alpha; the deferred fix removes the warning's reason to exist. A future opt-out (e.g. a `baseGrantsManagedExternally: true` marker) can silence it for consumers who own the prelude deliberately.

## Alternatives considered

- **Emit complement column-level REVOKEs (issue Option 1, as written).** Doesn't enforce — column REVOKE can't override a table-level GRANT. Rejected as incorrect.
- **Full enforcement now.** Correct but large: base-table grant ownership, DMMF in the compile path, deny-state in the lifecycle, and a migration story for the live consumer. Too much blast radius to bundle with the alpha.6 line; deferred to its own ADR + release.
- **Docs/JSDoc only (issue Option 3).** Cheapest, but the gap stays silent in tooling — a reader has to find the doc. The lint warning is strictly better at the same low cost and risk.

## References

- Issue #2
- [ADR-0004 — Column privileges vs row-conditional masking](./0004-column-privileges-vs-row-conditional-masking.md)
- [ADR-0008 — Idempotent DDL emission](./0008-idempotent-ddl-emission.md) (the deferred REVOKE/GRANT must stay idempotent)
- [ADR-0020 — Functional lifecycle over an Op union](./0020-functional-lifecycle-over-op-union.md) (where the future `grant-table`/`revoke-table` ops flow)
- [`packages/lint/src/coverage.ts`](../../packages/lint/src/coverage.ts) — the `column-privilege-unenforced` warning
- [`packages/emitter-postgres-column-privileges/src/emit.ts`](../../packages/emitter-postgres-column-privileges/src/emit.ts) — GRANT-only emitter
