---
'@flowchestra/prisma-guarddog-core': minor
'@flowchestra/prisma-guarddog-emitter-postgres-rls': minor
'@flowchestra/prisma-guarddog': minor
---

Add **restrictive policy support** for issue #26 (ADR-0032): a low-level `.restrictivePolicy(role).forAll(fn)` primitive and the domain-aware `.isolation(fn)` sugar that emits `<table>_isolation` as `AS RESTRICTIVE FOR ALL TO public`. Restrictive policies are AND'd with every permissive on the same table — an **inescapable floor**, so the tenant + soft-delete shape `(HARD floor) AND (SOFT access)` becomes structurally enforced instead of author-discipline-dependent. A future permissive break-glass policy cannot widen around the floor.

```ts
// Recommended (90% case): one isolation floor per table.
guard.model('Workspace').table('workspaces')
  .isolation((p) =>
    p.fn('current_tenant_id').eq(col('tenant_id')).and(p.raw('deleted_at IS NULL'))
  )
  .policy('app_user')
    .select((p) => /* access only — the floor is already AND'd */)

// Low-level primitive — escape hatch for non-public roles or distinct floors.
guard.model('Widget').restrictivePolicy('public')
  .forAll((p) => p.claim('tenantId').eq(col('tenant_id')), { name: 'tenant_isolation' })
```

- **core**: `PolicyAst` gains `restrictive?: boolean`, `all?: AllSpec`, `isolation?: boolean`; `Verb` extends to include `'all'`. `PolicyOpRecord` gains `restrictive?: boolean`. New `ModelBuilder.restrictivePolicy(role)` returns a `RestrictivePolicyBuilder` with `.named()` / `.forAll(fn, opts?)` / `.todo()`. New `ModelBuilder.isolation(fn, opts?)` desugars to `.restrictivePolicy('public').forAll(fn, opts)` with the isolation auto-name `<table>_isolation`. `compileToOps` threads the new fields and `policyRecordsEqual` treats a permissive ↔ restrictive flip as drift (forcing drop+recreate).
- **emitter-postgres-rls**: AST emitter renders `CREATE POLICY <name> ON <table> AS RESTRICTIVE FOR ALL TO <role> USING (...) WITH CHECK (...)`. Permissive emission unchanged (the default — no `AS PERMISSIVE` clause emitted to keep migrations stable). CLI `renderOps` does the same on the Op-based path.
- **cli (drift)**: new `restrictivenessMismatch` classification on `PolicyDrift` reporting a declared/live permissive↔restrictive disagreement on the same `(table, name)`. `guarddog drift` prints it as a hard failure (forces a reapply).

Pairs cleanly with ADR-0031: `.isolation(fn, { name: 'tenant_isolation' })` adopts a legacy hand-written restrictive in place atomically (DROP IF EXISTS + CREATE under the same name). Pairs with ADR-0026: the typical floor is `p.fn('current_tenant_id').eq(col('tenant_id')) AND p.col('deleted_at').isNull()`.

Backward compatible — every existing policy stays permissive; nothing renames, no migration required.
