# 0004 — Column privileges vs row-conditional masking

**Status:** Accepted
**Date:** 2026-05-23

## Context

"Column-level visibility" sounds like one concept. It is actually two, and Postgres handles them with different primitives:

- **Static column privileges:** `GRANT SELECT(api_key) ON workbenches TO app_system`. Role-based. The column is either visible to a role or it isn't. Independent of row content.
- **Row-conditional field visibility:** "show `notes` only if the requesting user is the row's owner." The same column may be visible on one row and hidden on the next. Cannot be expressed as a column GRANT — requires generated views, projection functions, or app-layer masking.

A single `.columns()` API that accepts both `role('app_system')` and `c => c.isOwner(col('ownerId'))` looks ergonomic. It silently mixes two enforcement mechanisms. The role-based case compiles cleanly to column GRANTs; the row-conditional case cannot, and would either fail at emit time or — worse — silently fall back to a different mechanism the user didn't ask for.

This is exactly the class of decision that ships as "works in dev, leaks in prod."

## Decision

Two distinct API primitives, never collapsed:

- **`.columnPrivileges()`** — emits Postgres column-level `GRANT`/`REVOKE`. Inputs are role names or simple role predicates. **Phase 1.**
- **`.masks()` / `.projection()`** — row-conditional field visibility. Emits generated secure views or projection functions depending on access path. **Phase 2.**

Phase 1 ships with `.columnPrivileges()` only. Row-conditional masking is deferred to Phase 2.

```ts
// Phase 1 (column privileges — static, role-based):
.columnPrivileges({
  apiKey:        { select: ['app_system'], update: ['app_system'] },
  internalNotes: { select: ['app_system', 'app_admin'] },
});

// Phase 2 (row-conditional masking — different primitive):
.masks({
  notes: mask.when(p => p.isOwner(col('ownerId'))).show().otherwiseNull(),
});
```

## Consequences

**Positive:**

- The compile target is unambiguous. `.columnPrivileges()` always emits column GRANTs. `.masks()` always emits a view/function.
- Authoring discipline: users have to choose which enforcement they want, not have it inferred.
- Phase 1 scope stays narrow.

**Negative:**

- Users with row-conditional visibility needs cannot solve them in Phase 1 — they must wait for `.masks()` or hand-roll views.
- Two APIs for what users might intuitively think of as one concept. Documentation burden.

## Alternatives considered

- **Unified `.columns()` API that accepts both forms and chooses the emission target by inspection:** rejected. The failure mode is silent: a predicate that "could be" role-based collapses to a column GRANT; a predicate that "could be" row-conditional gets compiled to a view. Users have no way to know which mechanism is in force without reading emitter source. This is exactly the magic-inference failure described in [ADR-0005](./0005-explicit-using-and-with-check.md).
- **Defer column-level visibility entirely to Phase 2:** rejected. Static column privileges are a real Phase 1 requirement (e.g., `apiKey`, `internalNotes` visibility per role). Pushing them out delays useful work.

## References

- [ADR-0005 — Explicit USING and WITH CHECK](./0005-explicit-using-and-with-check.md)
- [ADR-0014 — Phase scope boundaries](./0014-phase-scope-boundaries.md)
