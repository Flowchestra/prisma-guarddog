# 0019 — Three permission layers + per-resource jsonb permissions

**Status:** Accepted (supersedes [ADR-0003](./0003-four-primitive-split.md))
**Date:** 2026-05-23

## Context

ADR-0003 originally split authorization into four primitives: `dbRoles`,
`businessRoles`, `resources`, and `grants`. That captured the right separation
of concerns — DB-role inheritance ≠ application-role membership ≠ resource
cascade ≠ grant records — but left two things underdetermined:

1. **`grants` was a conceptual placeholder.** There was no API for declaring
   the action vocabulary or the resolution strategy (claims-based vs.
   table-backed). Policies referenced grants implicitly via the scoped form
   of `hasRole`, conflating role membership (layer 2) with resource-scoped
   action checks (layer 3).
2. **No primitive covered denormalized app-defined access.** Some
   authorization is fundamentally per-row metadata — a `permissions: jsonb`
   column carrying an arbitrary access list — and didn't fit any of the four
   primitives.

The realignment in [ADR-0018](./0018-schema-file-as-primary-interface.md)
prompted a closer look at the user-facing vocabulary, surfacing both issues
as concrete API gaps.

## Decision

**Three permission layers**, each separately declared and separately
referenceable in policy predicates:

1. **`dbRoles`** — Postgres roles created via `CREATE ROLE`. dbRole
   inheritance is structural Postgres inheritance (`GRANT app_user TO
   app_system`). Authored via `defineDbRoles`. Referenced via the `.policy(role)`
   slot — the target of `CREATE POLICY ... TO <role>`. Compiled by
   `@flowchestra/prisma-guarddog-emitter-postgres-rls`' `emitRoles()`.

2. **`appRoles`** — application role names (`workspace.admin`,
   `workbench.editor`). Renamed from `businessRoles` in commit 1ff622e to
   align with the three-layer vocabulary. Authored via `defineAppRoles`.
   Referenced via `p.hasAppRole(role)`. Resolved against the `roles` jsonb
   array in the session claims.

3. **`resourceGrants`** — principal × action × resource records. Authored
   via `defineResourceGrants({ source, claimPath, actions })` (commit
   47213a1). Action vocabulary is declared as a `const`-typed array so
   `p.hasGrant('edit', col('workspaceId'))` type-checks against the declared
   set. Phase 1 supports `source: 'claims'` (jsonb object keyed by action
   name → array of resource IDs); Phase 2 adds `source: 'table'` with a
   guarddog-emitted grants table.

**One topology primitive** — distinct from the permission layers, not a
permission layer itself:

- **`resources`** — the resource tree (Tenant → Org → Workspace →
  Workbench). Declares parent/child relationships that policies cascade
  through. Authored via `defineResources`. The emitter walks the tree
  when expanding resource-scope grants.

**One orthogonal mechanism** — orthogonal because it lives ON each resource
row rather than in a separate registry:

- **Per-resource jsonb permissions** — a `permissions: jsonb` column on a
  resource carrying an app-defined access list (typically `{ users: { sub:
  [...actions] } }`). Referenced via `p.hasResourcePermission(action,
  col('permissions'))`. Lets denormalized application logic ride alongside
  row data without growing the central permission graph.

### Predicate API mapping

| Layer / Mechanism | Predicate | Compiles to |
| --- | --- | --- |
| dbRole | (none — it's the `TO <role>` slot on `CREATE POLICY`) | `CREATE POLICY ... TO <role>` |
| appRole | `p.hasAppRole(role)` | `(claims -> 'roles') ? '<role>'` |
| resourceGrant | `p.hasGrant(action, scopeCol)` | `(claims -> '<claimPath>' -> '<action>') ? <scopeCol>::text` |
| per-resource jsonb | `p.hasResourcePermission(action, jsonbCol)` | `(<jsonbCol> -> 'users' -> (claims ->> 'sub')) ? '<action>'` |
| ownership | `p.isOwner(col)` | `<col> = (claims ->> 'sub')::uuid` |

Every compilation is fully inline against the session claims or the row
itself — no consumer-side helper functions, no `app.*` schema (see
[ADR-0008](./0008-idempotent-ddl-emission.md) on idempotent emission and
ADR-0018 on self-contained emission as a principle).

## Consequences

**Positive:**

- The layer in play is explicit at every call site. `hasAppRole` is layer 2,
  `hasGrant` is layer 3, `hasResourcePermission` is the jsonb mechanism — no
  predicate hides its semantics behind an overloaded arg list.
- Action vocabulary is declarable and type-checked, enabling editor
  autocomplete + refactor support for grant strings.
- Per-resource jsonb permissions cover the "I need to express custom access
  lists on individual rows" case without forcing it through the role graph.
- ADR-0003's separation of concerns is preserved — the four-primitive
  insight is correct — but the underdetermined fourth primitive (`grants`)
  is now concrete and consumable.

**Negative:**

- Three predicate functions where the old `hasRole(role, scope?)` was one.
  Documentation burden goes up; tests have to cover three compilers
  instead of one.
- `resources` is no longer "one of four primitives" — it's a topology
  primitive. Casual readers may still assume it's a permission layer
  because the original ADR-0003 framed it that way. The GLOSSARY entry
  spells out the distinction.

## What was renamed / introduced (audit trail)

The implementation landed across several commits between aff8bb1 and
the schema-file CLI work:

  1ff622e   businessRoles -> appRoles (rename across source + docs)
  47213a1   defineResourceGrants primitive + Guarddog config slot
  8b8b544   hasAppRole / hasGrant / hasResourcePermission predicates
            (replaces hasRole; AST split; emitter rewrite)

## Alternatives considered

- **Keep ADR-0003 as-is and add a new "Phase 1 extensions" ADR** —
  rejected. ADR-0003's named primitives (specifically `businessRoles`,
  `grants`) are stale enough that leaving them as canonical creates
  confusion. Cleaner to mark the ADR superseded and point readers here.

- **Merge `resourceGrants` into `appRoles`** — rejected. Global role
  membership and resource-scoped action grants resolve via different SQL
  shapes (`?` against `roles` vs. nested lookup against
  `grants -> action`). Conflating them at the API layer would push the
  conflation problem into compilation: the emitter would need a flag to
  pick which form, and the user would have to know which form a
  particular `hasRole` call wanted.

- **Treat the per-resource jsonb as a kind of `resourceGrant`** —
  rejected. resourceGrants is principal-keyed (the user has these grants);
  per-resource jsonb is resource-keyed (the row carries this access list).
  Different storage, different SQL, different invalidation semantics —
  warrants distinct primitives.

## References

- [ADR-0003 — Four-primitive split](./0003-four-primitive-split.md) (superseded by this ADR)
- [ADR-0018 — Schema file as the primary interface](./0018-schema-file-as-primary-interface.md)
- [ADR-0004 — Column privileges vs row-conditional masking](./0004-column-privileges-vs-row-conditional-masking.md) (still applies — column privileges remain dbRole-based and static; row-conditional masking is Phase 2)
- [ADR-0008 — Idempotent DDL emission](./0008-idempotent-ddl-emission.md)
- [docs/GLOSSARY.md](../GLOSSARY.md) — vocabulary anchors the layer boundaries
