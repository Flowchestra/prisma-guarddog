---
'@flowchestra/prisma-guarddog-core': minor
'@flowchestra/prisma-guarddog-emitter-postgres-rls': minor
'@flowchestra/prisma-guarddog': minor
---

Add **named slots for restrictive policies** for issue #29 (ADR-0033). Multiple restrictive invariants can now coexist on the same `(model, dbRole)` — e.g., a boundary slot AND a no-soft-deleted slot — authored as **distinct `.isolation(slot, fn)` calls** rather than one AND-combined predicate. Each slot maps to its own `pg_policies` row with a meaningful name.

```ts
guard.model('Workspace').table('workspaces')
  // Two distinct invariants → two restrictive pg_policies rows.
  .isolation('boundary', (p) =>
    p.fn('current_tenant_id').eq(col('tenant_id')).and(
      p.or(
        col('org_id').eq(p.fn('current_org_id')),
        p.fn('org_has_cross_org_access', col('org_id'), p.fn('current_org_id'), 'WORKSPACE', col('id'), null),
      )
    )
  )
  .isolation('no_soft_deleted', (p) => p.raw('deleted_at IS NULL'))
  .policy('app_user').select((p) => /* access only — both floors AND'd */)

// Low-level slot form — same key shape.
guard.model('Widget').restrictivePolicy('public', 'boundary').forAll((p) => …)
guard.model('Widget').restrictivePolicy('public', 'no_soft_deleted').forAll((p) => …)
```

Backward compatible — alpha.14 calls without a slot hit the default slot (`'default'`) and resolve to the existing `<table>_isolation` / `<table>_<role>_all` auto-names unchanged.

**Auto-name resolution** (when no `.named(...)` override is set):

| Form | Auto-name |
| --- | --- |
| `.isolation(fn)` (default slot) | `<table>_isolation` *(alpha.14 preserved)* |
| `.isolation('boundary', fn)` | `<table>_boundary` |
| `.restrictivePolicy(role).forAll(fn)` (default slot) | `<table>_<role>_all` *(alpha.14 preserved)* |
| `.restrictivePolicy(role, 'boundary').forAll(fn)` | `<table>_<role>_boundary` |

- **core**: `PolicyAst` gains `slot?: string`. `RestrictivePolicyBuilder` constructor takes the slot and surfaces it via the readonly `slot` field. `ModelBuilder.restrictivePolicy(role, slot?)` and overloaded `ModelBuilder.isolation(slot?, fn, opts?)` accept an optional slot string. Registry re-keys from `(model, dbRole)` to `(model, dbRole, slot)`; same slot returns the same builder, different slots are independent. Lifecycle threads `slot` into `makeCreatePolicyOp` for slot-aware auto-naming. The existing compile-time duplicate-name guard ([ADR-0031](../docs/adr/0031-user-declared-policy-names.md)) catches collisions when two slots resolve to the same name.
- **emitter-postgres-rls**: AST emitter (`emitPolicy`) honors slot in the same name-resolution rules as the lifecycle.
- **lint**: slots are structural (no nudge). The existing `policy-uses-declared-name` warning still fires only on `.named()` / per-verb `{ name }`.

Pairs with the upcoming ADR-0034 (per-command restrictive policies) — once a restrictive can be `FOR SELECT`-only, the slot is the registry handle that lets distinct invariants target different command sets.
