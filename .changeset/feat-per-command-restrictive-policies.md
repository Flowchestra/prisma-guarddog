---
'@flowchestra/prisma-guarddog-core': minor
'@flowchestra/prisma-guarddog-emitter-postgres-rls': minor
'@flowchestra/prisma-guarddog': minor
---

Add **per-command restrictive policies** for issue #30 (ADR-0034). `RestrictivePolicyBuilder` gains `.forSelect / .forInsert / .forUpdate / .forDelete` alongside the existing `.forAll`, so a restrictive predicate can target only specific commands instead of all four. The canonical archetype is a SELECT-only soft-delete restrictive that filters reads against `deleted_at IS NULL` without coupling that floor to write operations.

```ts
guard.model('Workspace').table('workspaces')
  // Uniform tenant floor — every command.
  .isolation('boundary', (p) => p.claim('tenantId').eq(col('tenant_id')))
  // SELECT-only soft-delete restrictive — emits as `AS RESTRICTIVE FOR SELECT`.
  .restrictivePolicy('public', 'no_soft_deleted')
    .forSelect((p) => p.raw('deleted_at IS NULL'))
  // INSERT-only restrictive — blocks creating pre-soft-deleted rows.
  .restrictivePolicy('public', 'no_pre_deleted')
    .forInsert({ check: (p) => p.raw('deleted_at IS NULL') })
  // Permissive access — the floors are already AND'd in.
  .policy('app_user')
    .select((p) => /* visibility OR FGAC */)
```

API shape mirrors the existing permissive `PolicyBuilder` verb methods exactly:

- `.forSelect(fn, opts?)` — USING-only, FOR SELECT
- `.forInsert({ check, name? })` — WITH CHECK only, FOR INSERT (no USING per [ADR-0005](../docs/adr/0005-explicit-using-and-with-check.md))
- `.forUpdate({ using, check, name? })` — both, FOR UPDATE
- `.forDelete({ using, name? })` — USING-only, FOR DELETE
- `.forAll(fn, opts?)` — preserved; uniform predicate for all commands

**Mutex guard.** A single `RestrictivePolicyBuilder` holds either `.forAll` or any subset of per-verb specs — never both. Mixing them on the same builder throws at the second call with a clear error message ("catalog-distinct in Postgres; use distinct slots to express both shapes"). To author both shapes on the same `(model, dbRole)`, declare them under distinct slots ([ADR-0033](../docs/adr/0033-named-slots-for-restrictive-policies.md)).

**Auto-name resolution.** Per-verb specs follow the existing convention:

| Form | Auto-name |
| --- | --- |
| `.forSelect(fn)` (default slot) | `<table>_<role>_select` |
| `.forSelect(fn)` (with slot) | `<table>_<role>_<slot>_select` |
| Same shape for `.forInsert / .forUpdate / .forDelete` | (verb in the suffix) |

`.named(name)` / per-call `{ name }` overrides continue to win over the auto-name.

**Note on Postgres semantics.** SELECT policies — permissive *and* restrictive — also gate row-visibility for UPDATE / DELETE row-finding. That's a Postgres behavior, not a guarddog one. A `forSelect` restrictive that hides soft-deleted rows will therefore also prevent `UPDATE WHERE id = X` from finding those rows by their ID. For undelete-style flows in practice, use a BYPASSRLS role (`app_system`) or place the operation behind a SECURITY DEFINER function ([ADR-0026](../docs/adr/0026-managed-sql-functions.md)).

- **core**: `RestrictivePolicyBuilder` gains `_select / _insert / _update / _delete` internal fields and the four per-verb methods; `_toAst()` returns them on the `PolicyAst` (alongside the existing `all` for `.forAll`). The mutex guard runs on every call. No new AST shapes — the per-verb specs reuse `SelectSpec / InsertSpec / UpdateSpec / DeleteSpec`.
- **lifecycle**: `appendPolicyOps` already iterated per-verb specs; threads `pol.restrictive` and `pol.slot` through the per-verb branches (previously hardcoded `false / undefined`). The name-resolution rule extends to handle the slot+verb combination as `<table>_<role>_<slot>_<verb>`.
- **emitter-postgres-rls**: per-verb name resolution honors the slot; restrictive emission unchanged at the SQL-shape level (the existing `AS RESTRICTIVE` clause was already threaded through every verb branch in alpha.14).
- **drift**: no new code — `restrictivenessMismatch` ([ADR-0032](../docs/adr/0032-restrictive-policy-support.md)) already catches per-verb permissive ↔ restrictive flips by virtue of being keyed on `(table, name)` regardless of the verb.

Pairs with [ADR-0033](../docs/adr/0033-named-slots-for-restrictive-policies.md) — the canonical multi-invariant shape is now `.isolation('boundary', fn)` (uniform tenant floor) + `.restrictivePolicy('public', 'no_soft_deleted').forSelect(...)` (SELECT-only read floor) on the same model.
