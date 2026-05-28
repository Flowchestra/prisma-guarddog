# 0023 — Grant principal disjunction (user OR group via `groupMemberTable`)

**Status:** Accepted
**Date:** 2026-05-28

## Context

`source: 'table'` (ADR-0021) assumed a single `principalColumn` — the EXISTS clause matched one column against the requesting principal. Many real grant tables instead carry an **XOR principal**: each grant row references EITHER a user OR a group (enforced by a CHECK constraint), and group grants resolve to the requesting user transitively through a membership table. Flowchestra's `workspace_grants` and `workbench_grants` are both this shape (issue #6); a group grant means "everyone in this group has this grant."

During the alpha.2 pilot this forced a `compileHasGrant` override solely to emit the user-OR-group disjunction.

## Decision

Extend the principal spec on both grant-table shapes:

```ts
principalUserColumn: 'user_id',        // explicit spelling; `principalColumn` is the alias
principalGroupColumn: 'group_id',      // optional
groupMemberTable: {                    // required iff principalGroupColumn is set
  name: 'org_group_members',
  userColumn: 'user_id',
  groupColumn: 'group_id',
},
```

The principal clause becomes:

```sql
(<grant>.user_id = <principal>
 OR <grant>.group_id IN (
   SELECT <gm>.group_id FROM <gm> WHERE <gm>.user_id = <principal>
 ))
```

`principalColumn` is retained as a backward-compatible alias for `principalUserColumn` (single-principal configs from ADR-0021 are unchanged). All membership-table columns are qualified with the membership table name so the nested sub-select can't ambiguate against the grant table.

**Validation:**
- Exactly one user-column spelling: `principalColumn` XOR `principalUserColumn`.
- `principalGroupColumn` and `groupMemberTable` are all-or-nothing (declaring one without the other is an error).
- `groupMemberTable.{name,userColumn,groupColumn}` must all be non-empty.

## Consequences

**Positive**
- User-OR-group grants are declarative; the disjunction override disappears.
- Composes with rank-based grants (ADR-0022) on the same table — Flowchestra's `workspace_grants` is both.
- The CHECK-constraint XOR on the consumer's table is honored naturally: a row with `user_id` set matches the first disjunct, a row with `group_id` set matches the second.

**Negative**
- **Single-level membership only.** The sub-select resolves direct membership. **Nested groups** (groups containing groups) need a recursive CTE the API doesn't express — a consumer with that shape is back to a `compileHasGrant` override. We chose the flat case because it covers Flowchestra and the vast majority of group models; a recursive variant can be added behind an explicit flag if requested, rather than paying the recursive-CTE cost (and its cycle-guard complexity) for everyone.
- The membership sub-select runs per outer row unless Postgres hoists it; for hot paths consumers may want the membership materialized into a claim instead. Documented, not optimized.

## Alternatives considered

- **Resolve group membership into a JWT claim at session issuance, keep single-column principal.** Avoids the join entirely, but bloats the claim and goes stale when membership changes mid-session — the exact problem table-backed grants exist to avoid. Rejected for group-heavy models; still available to consumers who prefer it via `source: 'claims'`.
- **A general `principalPredicate` SQL template instead of structured user/group columns.** Maximum flexibility, but it's a `rawSql` escape hatch wearing a config hat — no validation, no type safety. The structured shape covers the common case declaratively; the genuine escape hatch remains `compileHasGrant`.

## References

- [ADR-0021 — Table-backed resource grants](./0021-table-backed-resource-grants.md)
- [ADR-0022 — Rank-based grant tables](./0022-rank-based-grant-tables.md)
- Issue #6; reference override: `Flowchestra-Frontend/src/server/rls/guarddog/compile-has-grant.ts`
- [`packages/emitter-postgres-rls/src/compile-expr.ts`](../../packages/emitter-postgres-rls/src/compile-expr.ts) — `emitPrincipalClause`
