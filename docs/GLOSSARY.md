# Glossary

Terminology in `prisma-guarddog`. **Discipline here is load-bearing** — same
word, different concept, different code path. Conflating these is a footgun
(see [ADR-0019](./adr/0019-three-permission-layers-and-resource-permissions.md),
which supersedes ADR-0003).

## The three permission layers

Authorization is modeled as three distinct, separately-declared layers. Each
layer has its own predicate function and its own SQL compilation strategy.
Casual conversation may call all of these "permissions" — the API spells out
which layer is in play at every call site.

### `dbRole` (layer 1)

A Postgres database role, created via `CREATE ROLE`. Examples: `app_user`,
`app_system`. dbRoles are the principals on the `TO <role>` side of every
emitted `CREATE POLICY`. They are the only one of the three layers that maps
to a Postgres-native object.

Authored via `defineDbRoles({...})`. Emitted as DDL by
`@prisma-guarddog/emitter-postgres-rls`'s `emitRoles()`.

**dbRole inheritance** is structural inheritance between Postgres roles —
emitted as `GRANT app_user TO app_system` (the membership grant). This is
**not** the same as resource-scope cascade and **not** the same as appRole
membership.

### `appRole` (layer 2)

An application-level role expressed as a string in the user's claims.
Examples: `workspace.admin`, `workbench.editor`, `org.viewer`. appRoles are
**not** Postgres roles — they're evaluated by predicates inside `USING` /
`WITH CHECK` clauses against the JWT claims set in the session.

Authored via `defineAppRoles({...})` (renamed from `businessRoles` in commit
1ff622e). Referenced via `p.hasAppRole('workspace.admin')`. Default
compilation:

```sql
((current_setting('<accessor>', true)::jsonb -> 'roles') ? 'workspace.admin')
```

The `roles` claim is expected to be a jsonb array of role strings. Override
the resolution via `ExprCompileCtx.compileHasAppRole` for non-default shapes.

### `resourceGrant` (layer 3)

A principal × action × resource record. The third permission layer answers
"does the requesting user have permission to perform `<action>` on the
resource identified by `<scopeColumn>`?"

Authored via `defineResourceGrants({ source, claimPath, actions })`. The
`actions` array declares the vocabulary so `p.hasGrant('edit', col('id'))`
type-checks against the declared set. Phase 1 supports `source: 'claims'` —
grants encoded as a jsonb object on the session claims keyed by action name
→ array of resource IDs. Phase 2 will add `source: 'table'` backed by a
guarddog-emitted grants table.

Referenced via `p.hasGrant(action, scopeColumnRef)`. Default compilation:

```sql
((current_setting('<accessor>', true)::jsonb -> '<claimPath>' -> '<action>')
  ? <scopeColumnRef>::text)
```

## Topology (not a permission layer)

### `resource`

A node in the **resource tree** (typically `Tenant → Org → Workspace →
Workbench`). Resources are a *topology* declaration, not a permission layer —
they declare how resources nest and how access propagates through the
hierarchy.

Authored via `defineResources({...})`. Drives **resource-scope cascade**:
a grant at one resource level (e.g., admin on workspace `W`) propagates to
its children (every workbench within `W`). The emitter walks the resource
tree when expanding grants.

## Orthogonal mechanism

### `per-resource jsonb permission`

Denormalized application access logic that lives ON each resource row
rather than in the central permission graph. A `permissions: jsonb` column
on a resource carries an app-defined access list, typically shaped:

```json
{
  "users":  { "<sub>": ["read", "write", "delete"] },
  "groups": { "engineering": ["read"] }
}
```

Referenced via `p.hasResourcePermission(action, col('permissions'))`.
Default compilation:

```sql
((<jsonbColumn> -> 'users' -> (current_setting('<accessor>', true)::json ->> 'sub'))
  ? '<action>')
```

Distinct from resourceGrants because it's *resource-keyed* (the row carries
the access list) rather than *principal-keyed* (the session carries the
grant set).

## Verb-level vocabulary

### `policy`

A Postgres RLS policy: a named rule attached to a table for a verb
(`SELECT`/`INSERT`/`UPDATE`/`DELETE`) with `USING` and/or `WITH CHECK`
predicates. Authored via `guard.model(X).policy(dbRole).select(...)` etc.
USING and WITH CHECK are always explicit per [ADR-0005](./adr/0005-explicit-using-and-with-check.md).

### `predicate`

A boolean expression evaluated at query time inside a policy's `USING` or
`WITH CHECK` clause. Built from claim accessors (`p.claim('tenantId')`),
column references (`col('tenantId')`), and combinators (`.and()` / `.or()` /
`.not()`). Higher-level helpers wrap the three permission layers:
`hasAppRole`, `hasGrant`, `hasResourcePermission`, plus `isOwner`,
`inArray`, and the `raw()` escape hatch.

### `claim`

A field in the JWT (or other session-stamped data) accessible inside
policies via `current_setting('<accessor>', true)::json ->> '<field>'`. The
claim schema is declared once via `defineClaims({ shape: ... })`.

## Column visibility

### `columnPrivilege`

A static Postgres column-level grant: `GRANT SELECT(api_key) ON workbenches
TO app_system`. Role-based (dbRole), **not** row-conditional. Phase 1 covers
this via `.columnPrivileges()` on the ModelBuilder.

### `mask` / `projection`

**Phase 2.** A row-conditional field-visibility mechanism — different rows
show different fields based on a predicate. Implemented via generated
secure views or projection functions. **Distinct from `columnPrivilege`**,
which is static per-role (see
[ADR-0004](./adr/0004-column-privileges-vs-row-conditional-masking.md)).

## Migration vocabulary

### `sidecar`

A `guarddog.json` file colocated with a `migration.sql` in
`prisma/migrations/<timestamp>_<name>/`. Contains the ops log for that
migration. Forward-replaying all sidecars in `_prisma_migrations` ledger
order derives the currently-deployed policy state (see
[ADR-0006](./adr/0006-sidecar-migration-metadata.md),
[ADR-0007](./adr/0007-forward-replay-state-derivation.md)).

### `polymorphic grant`

A policy declared once against a logical entity (e.g., `ScopeTarget`) and
emitted as per-target policies via a discriminator column. Authored via
`guard.polymorphic('ScopeTarget', { discriminator: 'targetType' })
.target('Workspace', { model: 'Workspace' }).policy('app_user').select(...)`.
The emitter auto-prepends the discriminator equality to each target's
predicates.

### `scaffold-mode import`

The only mode the importer operates in. Reads `pg_policies` + column
privileges from a live database and emits TS files with `rawSql()` +
`.todo()` placeholders, plus `noPolicy()` stubs for any uncovered models.
The importer **never** attempts to reverse-engineer business intent from
SQL — SQL is evidence, not gospel (see
[ADR-0012](./adr/0012-scaffold-only-importer.md)).
