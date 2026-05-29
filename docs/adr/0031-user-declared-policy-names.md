# 0031 — Opt-in user-declared policy names (`.named()` + per-verb `{ name }`)

**Status:** Accepted (implemented)
**Date:** 2026-05-29

## Context

guarddog's policies are keyed by `(model, dbRole)` with names auto-generated as `<table>_<role>_<command>`. That convention is the steady-state default and the right choice when nothing references a policy by name. ADR-0029 and ADR-0030 give consumers two ways to cross over an existing database: `migrate --drop-unmanaged` (a one-shot cutover) and `guarddog adopt --edit/remove/keep` (interactive, per-policy). Both work, but neither closes the **additive cutover window**: during the migration, the legacy policy (`workspaces_visibility_select`) and guarddog's new policy (`workspace_app_user_select`) coexist, and because permissive policies OR in Postgres, access can **widen** for the duration of that window.

If a verb spec could declare the legacy name, the emitter would render `DROP POLICY IF EXISTS workspaces_visibility_select; CREATE POLICY workspaces_visibility_select …` — an **atomic in-place replacement**, no widening window, table by table or policy by policy. That's the missing primitive.

## Decision

Add an optional `name?: string` to each per-verb spec (`SelectSpec` / `InsertSpec` / `UpdateSpec` / `DeleteSpec`) and two builder shapes for setting it:

```ts
// Per-verb option — local, primitive, wins if both set.
guard.model('Workspace').policy('app_user')
  .select((p) => p.claim('tenantId').eq(col('tenantId')), { name: 'workspaces_visibility_select' })

// Chained `.named()` — persists across subsequent verbs in the chain.
// `.named(undefined)` resets; a fresh `.policy()` also resets.
guard.model('Workspace').policy('app_user')
  .named('workspaces_visibility_select')
  .select((p) => p.claim('tenantId').eq(col('tenantId')))
  .insert({ check: (p) => …, name: 'workspaces_visibility_insert' })  // per-verb wins
  .update({ using: …, check: … })                                      // still 'workspaces_visibility_select'
```

**Resolution:** per-verb `{ name }` > chained `.named()` > auto-gen `<table>_<role>_<command>`.

**Identity.** The declared name flows through `compileToOps` into the `PolicyOpRecord.name` field — the same key the lifecycle and emitter already use. No new identity concept; the existing State/diff/render machinery just sees a different name for that policy. The emitter (both the Op-based `renderOps` and the AST-based `emitPolicy`) renders the resolved name in both `DROP POLICY IF EXISTS` and `CREATE POLICY`, so the cutover is atomic.

**Duplicate guard.** `compileToOps` rejects two declared policies on the same table with the same name (silent overwrite would otherwise be possible). Postgres enforces uniqueness at apply time too, but a compile-time error gives a better signal.

**Lint nudge — the seam.** A new warning, `policy-uses-declared-name`, fires for every verb spec carrying a non-undefined `name`. The message surfaces the auto-gen target so authors see the canonical name they should converge on once adoption finishes. The warning isn't an error — it's continuous gentle pressure away from the opt-in escape hatch and back to the default convention.

## Consequences

**Positive**
- Closes the additive cutover window: typed replacements ship as in-place `DROP IF EXISTS … ; CREATE …` under the legacy name. Pairs cleanly with `adopt --edit` (whose `rawSql + .todo()` scaffold is the typical authoring path).
- Backward compatible: every consumer who doesn't pass a name gets the existing auto-gen behavior unchanged.
- The lint warning is the durable nudge — declared names are a transitional tool, not an aesthetic preference. The seam is explicit.
- Same primitive serves polymorphic-target verbs (which also support both the per-verb option and `.named()`).

**Negative**
- Two ways to set a name. Mitigated by a single resolution rule (per-verb > chained > auto) and the lint warning that surfaces both forms.
- A consumer who keeps declared names permanently loses some of the steady-state benefits (refactor-by-rename via `@@map`, drift coherence). The lint nudges away from this; it's not blocked because there are edge cases (a permanent legacy contract that can't be renamed) where it's the right call.
- Polymorphic targets default to `<table>_<role>_<verb>_<discriminator>`; a declared name *replaces the whole name* (the discriminator suffix is the author's responsibility when overriding). Documented.

## Alternatives considered

- **Auto-generated names only, forever.** The steady-state ideal, but leaves the additive cutover window open. Rejected — the widening hazard is real and the issue's mitigation is small and localized.
- **A separate `legacyName` field** (distinct from a real `name`). Two-config-fields-same-purpose; the lint can't easily distinguish "transitional" from "permanent." Rejected in favor of one field + a single warning.
- **Apply declared names only to the emitter (not the Op key).** The Op key is the lifecycle's identity for diff/drop/create; using one name in the catalog and another in State guarantees drift-engine confusion. Rejected.

## References

- [ADR-0029 — Handling existing (foreign) RLS policies](./0029-handling-existing-rls-policies.md) — drift engine, ownership marker, `migrate --drop-unmanaged`
- [ADR-0030 — Interactive adoption triage (`guarddog adopt`)](./0030-interactive-adoption-triage.md) — `adopt --edit` / `override` scaffold this pairs with
- Issue #25
- [`packages/core/src/ast.ts`](../../packages/core/src/ast.ts) — verb specs with `name?`
- [`packages/core/src/guarddog.ts`](../../packages/core/src/guarddog.ts) — `PolicyBuilder.named()` + per-verb options
- [`packages/lint/src/coverage.ts`](../../packages/lint/src/coverage.ts) — `policy-uses-declared-name` warning
