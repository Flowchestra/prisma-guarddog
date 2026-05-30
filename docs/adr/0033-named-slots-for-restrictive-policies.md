# 0033 — Named slots for restrictive policies

**Status:** Accepted (implemented)
**Date:** 2026-05-30

## Context

ADR-0032 shipped restrictive policy support with a `(model, dbRole)` registry that's singleton-keyed. Repeated `.restrictivePolicy('public')` calls on the same model return the same builder, and the second `.forAll(fn)` overwrites the first. That's correct when a single restrictive predicate captures the table's invariant (the common case: tenant scoping + soft-delete inlined into one AND'd predicate).

It stops being correct the moment two distinct restrictive invariants share a `(model, dbRole)`. Two cases force the issue:

1. **Multi-invariant restrictives on one table.** A table that needs both `(tenant scope OR cross-org scope)` and `deleted_at IS NULL` has two **conceptually independent** invariants. AND-combining them in `.forAll(fn)` works at the SQL level (multiple restrictives AND'd is equivalent to one restrictive with the conjunction), but it's a poor authoring shape: the boundary predicate and the soft-delete predicate evolve on different schedules, diff together every time either changes, share a code site they shouldn't share, and end up in `pg_policies` as a single opaque row instead of two grep-friendly ones (`workspaces_boundary` + `workspaces_no_soft_deleted`).

2. **Pairs with per-command restrictives ([ADR-0034](./0034-per-command-restrictive-policies.md)).** Once a restrictive can be `FOR SELECT`-only, distinct invariants must be distinct policies — they target different command sets and Postgres represents them as distinct `pg_policies` rows by construction. The slot is the registry handle the DSL needs to address them.

Postgres semantics already match the desired shape: multiple restrictives on the same table all AND together regardless of how the DSL packaged them, so this is purely an authoring-layer change.

## Decision

Re-key the restrictive-policy registry from `(model, dbRole)` to `(model, dbRole, slot)`. `slot` defaults to `'default'` so every alpha.14 call keeps working unchanged.

### API surface

```ts
// Sugar — overloaded to accept an optional slot as the first argument.
.model('Workspace')
  .isolation((p) => …)                              // slot='default', alpha.14 behavior
  .isolation('boundary', (p) => …)                  // slot='boundary'
  .isolation('no_soft_deleted', (p) => …)           // slot='no_soft_deleted'

// Low-level primitive — slot as the optional second argument.
.model('Workspace')
  .restrictivePolicy('app_user')                    // slot='default'
  .restrictivePolicy('app_user', 'boundary')        // slot='boundary'
```

Each `(model, dbRole, slot)` tuple has its own `RestrictivePolicyBuilder` — idempotent within a slot (same slot returns the same builder), independent across slots.

### Auto-name resolution

| Form | Auto-name |
| --- | --- |
| `.isolation(fn)` (slot='default') | `<table>_isolation` *(alpha.14 preserved)* |
| `.isolation('boundary', fn)` | `<table>_boundary` |
| `.restrictivePolicy(role).forAll(fn)` (slot='default') | `<table>_<role>_all` *(alpha.14 preserved)* |
| `.restrictivePolicy(role, 'boundary').forAll(fn)` | `<table>_<role>_boundary` |

`.named(name)` and per-call `{ name }` overrides ([ADR-0031](./0031-user-declared-policy-names.md)) continue to win over the auto-name. The isolation sugar drops the role from the auto-name because isolation policies are always `TO public`; the low-level primitive keeps the role in the name to disambiguate distinct roles using the same slot.

### AST + Op record

`PolicyAst` gains an optional `slot?: string` field set on restrictive policies. The field is purely for naming and registry identity — it has no effect on emitted SQL beyond the resolved policy name. `PolicyOpRecord` does **not** need a separate slot field: the resolved name in the Op record is the only identity Postgres sees, and the existing duplicate-name guard ([ADR-0031](./0031-user-declared-policy-names.md)) catches collisions at compile time if two slots resolve to the same name.

### Lint

Slots are a structural distinction, not an aesthetic preference. The existing `policy-uses-declared-name` warning does NOT fire on a non-default slot — only on `.named()` / per-verb `{ name }`. A slot is "the right way to express two distinct invariants on the same table"; a declared name is "transitional override I should drop." Different signals, different ergonomics.

## Consequences

**Positive**

- Multi-invariant restrictive shapes (boundary AND no-soft-deleted, etc.) become idiomatic: one slot per invariant, distinct `pg_policies` rows with meaningful names, independent diff coherence, independent reviewability.
- Backward compatible: every alpha.14 call hits slot=`'default'`, unchanged. The duplicate-name guard catches any inadvertent collision at compile time.
- Composes with [ADR-0034](./0034-per-command-restrictive-policies.md): the `(model, dbRole, slot)` builder is exactly the right handle for `.forSelect / forInsert / forUpdate / forDelete` — each builder holds one of `.forAll` or any subset of per-verb specs.
- The auto-name shape `<table>_<slot>` (for isolation) and `<table>_<role>_<slot>` (for low-level) matches the existing permissive `<table>_<role>_<verb>` convention closely enough that operators reading `pg_policies` see consistent shape.

**Negative**

- The `.isolation()` overload (optional first-arg slot string) is mildly heterogeneous. Mitigated by typed overloads (the first arg is either `string` or `PredicateFn` — TypeScript narrows correctly) and by the fact that the sugar's common case (one isolation floor, no slot) keeps the alpha.14 shape verbatim.
- Two slots on the same `(model, role)` with declared names that resolve to the same string would silently overwrite at apply time *if Postgres did not enforce uniqueness*. The compile-time `assertNoDuplicatePolicyNames` guard from ADR-0031 catches this with a clear error.

## Alternatives considered

- **AND-combine restrictives in a single `.forAll`.** The status quo. Rejected — author-discipline failure mode for the same reasons inlining the floor in every permissive was rejected by ADR-0032: distinct invariants should be distinct policies, period.
- **Multiple builder calls on the same singleton, accumulating predicates.** I.e. let `.forAll(fn1).forAll(fn2)` mean "two restrictives." Rejected — `.forAll` already has overwrite semantics consistent with the per-verb permissive builder methods, and changing that breaks the principle that the same method call shape always means the same thing.
- **Make the slot field required on `.restrictivePolicy(role, slot)` but optional on `.isolation(slot, fn)`.** Rejected — gratuitous asymmetry; the default slot `'default'` is the common case for both forms and the alpha.14 ergonomics matter.
- **A separate `.restrictivePolicyNamed(role, name, fn)` shape that bakes the literal name.** Rejected — that's what `.named()` is for ([ADR-0031](./0031-user-declared-policy-names.md)); slots and declared names are different concepts (structural vs aesthetic) and conflating them at the API would muddy lint signals.

## References

- [ADR-0032 — Restrictive policy support](./0032-restrictive-policy-support.md) — the alpha.14 baseline this extends
- [ADR-0031 — User-declared policy names](./0031-user-declared-policy-names.md) — the orthogonal name-override mechanism + duplicate-name compile-time guard
- [ADR-0034 — Per-command restrictive policies](./0034-per-command-restrictive-policies.md) — the sibling that lands next; together they unlock the canonical multi-invariant shape
- Issue #29
- [`packages/core/src/ast.ts`](../../packages/core/src/ast.ts) — `PolicyAst.slot`
- [`packages/core/src/guarddog.ts`](../../packages/core/src/guarddog.ts) — `ModelBuilder.restrictivePolicy(role, slot?)`, `ModelBuilder.isolation(slot?, fn, opts?)`, registry keyed on `(model, dbRole, slot)`
