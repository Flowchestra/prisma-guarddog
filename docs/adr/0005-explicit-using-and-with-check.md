# 0005 — Explicit USING and WITH CHECK

**Status:** Accepted
**Date:** 2026-05-23

## Context

Postgres RLS policies have two predicate slots with different semantics:

- **`USING`** — applied to existing rows. Filters what `SELECT`/`UPDATE`/`DELETE` can see or affect.
- **`WITH CHECK`** — applied to new or modified row data. Constrains what `INSERT`/`UPDATE` can produce.

For `UPDATE`, both apply: `USING` determines which rows are eligible to update; `WITH CHECK` determines what the new row values are allowed to be.

A common shortcut in policy DSLs is to accept a single predicate per verb and "infer" the other clause. The shortcut fails closed only when the predicates happen to be symmetric. The interesting failure mode is asymmetric: a permissive `USING` paired with a missing `WITH CHECK` lets users update rows they can see into shapes they shouldn't be allowed to write.

This bug is invisible in development against a single tenant. It manifests in production when a multi-tenant user updates `tenantId` to move a row to another tenant — `USING` passed (it was their row); `WITH CHECK` was never specified, so the move succeeds.

## Decision

Authoring `insert`, `update`, and `delete` requires explicitly specifying which predicate slot is being defined. There is no implicit copy of `USING` into `WITH CHECK` or vice versa.

```ts
.select(p => /* USING */)
.insert({
  check: p => /* WITH CHECK */
})
.update({
  using: p => /* USING — which rows can be updated */,
  check: p => /* WITH CHECK — what shape the result must have */,
})
.delete({
  using: p => /* USING */,
})
```

`select` and `delete` only have `using`. `insert` only has `check`. `update` has both, and both are mandatory if the verb is declared.

## Consequences

**Positive:**

- The emitted SQL maps 1:1 to the authored TypeScript. No hidden inference.
- The asymmetric failure mode (permissive USING, missing CHECK) becomes impossible to express by accident.
- Policy review is concrete: a reviewer sees both clauses and can reason about each.

**Negative:**

- More verbose than a single-predicate-per-verb DSL.
- New users must learn the USING/WITH CHECK distinction. Documentation in `GLOSSARY.md` mitigates.

## Alternatives considered

- **Single predicate per verb, inferred to both clauses:** rejected. The failure mode is silent and security-relevant.
- **Default `WITH CHECK` to the same predicate as `USING` unless overridden:** rejected. "Default to the same" is the magic-inference path with extra steps. Either be explicit or be wrong.
- **Allow a single predicate when symmetric, require split when asymmetric:** rejected as too clever. Users have to remember which mode they're in.

## References

- [ADR-0004 — Column privileges vs row-conditional masking](./0004-column-privileges-vs-row-conditional-masking.md)
- [ADR-0008 — Idempotent DDL emission](./0008-idempotent-ddl-emission.md)
