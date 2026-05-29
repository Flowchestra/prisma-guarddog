---
'@flowchestra/prisma-guarddog-core': minor
'@flowchestra/prisma-guarddog-emitter-postgres-rls': minor
'@flowchestra/prisma-guarddog-lint': minor
---

Opt-in **user-declared policy names** for transitional legacy adoption (ADR-0031, issue #25). Closes the additive cutover window: a typed replacement under a legacy name renders `DROP POLICY IF EXISTS <legacy>; CREATE POLICY <legacy> …` and upgrades the policy in place, atomically — no widening from the OR'd permissive coexistence the auto-gen names would otherwise create.

Two builder shapes, both supported:

```ts
// Per-verb option — local, primitive, wins if both set.
guard.model('Workspace').policy('app_user')
  .select((p) => p.claim('tenantId').eq(col('tenantId')), { name: 'workspaces_visibility_select' })

// Chained `.named()` — persists across subsequent verbs; `.named(undefined)` resets;
// a fresh `.policy()` also resets.
guard.model('Workspace').policy('app_user')
  .named('workspaces_visibility_select')
  .select((p) => …)
  .insert({ check: (p) => …, name: 'workspaces_visibility_insert' })  // per-verb wins
  .update({ using: …, check: … })                                      // still 'workspaces_visibility_select'
```

Resolution: per-verb `{ name }` > chained `.named()` > auto-gen `<table>_<role>_<command>`.

- **core**: `name?: string` on `Select/Insert/Update/Delete` specs; `PolicyBuilder.named()` + per-verb option; same on polymorphic-target builders. `compileToOps` threads the declared name into the policy Op and rejects two policies sharing `(table, name)` at compile time (Postgres would catch it at apply; compile-time error is a better signal).
- **emitter-postgres-rls**: AST-based `emitPolicy` / `emitPolymorphic` resolve `spec.name ?? policyName(...)` for both `DROP POLICY IF EXISTS` and `CREATE POLICY` — the Op-based `renderOps` path already used the Op's name unchanged.
- **lint**: new `policy-uses-declared-name` warning (non-failing) for every verb spec carrying a declared name, surfacing the auto-gen target so authors converge on the convention once adoption is complete.

Backward compatible — every consumer who doesn't pass a name gets the existing auto-gen behavior unchanged. The lint warning is the durable nudge: declared names are a transitional escape hatch, not an aesthetic preference. Pairs naturally with `guarddog adopt --edit` (ADR-0030), which scaffolds `rawSql(<legacy>) + .todo()` under the legacy name; once the typed predicate replaces the rawSql, the emit upgrades the legacy policy in place.
