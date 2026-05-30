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
`@flowchestra/prisma-guarddog-emitter-postgres-rls`'s `emitRoles()`.

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
type-checks against the declared set. Two sources supported: `source:
'claims'` (grants encoded as a jsonb object on the session claims keyed by
action name → array of resource IDs), and `source: 'table'` (per-resource
grant tables + polymorphic fallback, shipped in alpha.2 — see
[ADR-0021](./adr/0021-table-backed-resource-grants.md)). Rank-based
(`roleColumn` + `roleHierarchy`, [ADR-0022](./adr/0022-rank-based-grant-tables.md))
and group-disjunctive (`groupMemberTable`, [ADR-0023](./adr/0023-grant-principal-disjunction.md))
grant-table modes shipped in alpha.3.

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
(`SELECT` / `INSERT` / `UPDATE` / `DELETE` / `ALL`) with `USING` and/or
`WITH CHECK` predicates. Authored via `guard.model(X).policy(dbRole).select(...)`
for permissive policies. USING and WITH CHECK are always explicit per
[ADR-0005](./adr/0005-explicit-using-and-with-check.md).

### `permissive` vs `restrictive`

A policy's **kind**, governing how it composes with other policies on the
same table. Postgres semantics:

- **Permissive** policies are OR'd together across the `(table, command)` —
  adding a permissive **widens** access. Every guarddog `.policy(...)` builder
  emits permissive by default. Postgres omits the `AS PERMISSIVE` keyword
  (it's the default), and so does guarddog's emit.
- **Restrictive** policies are AND'd with every other policy on the table —
  restrictive predicates are an **inescapable floor**. Future permissives
  (break-glass, support tooling, shared-link) cannot widen around them.
  Emitted as `AS RESTRICTIVE`. Authored via `.restrictivePolicy(role).forAll(fn)`
  or the `.isolation(fn)` sugar. See
  [ADR-0032](./adr/0032-restrictive-policy-support.md).

### `isolation`

The recommended shape for the tenant + soft-delete restrictive floor.
`.isolation(fn)` desugars to `.restrictivePolicy('public').forAll(fn)` with
the auto-name `<table>_isolation`. Applies to all commands (`FOR ALL`) and
all roles (`TO public`). The conceptual model `(HARD floor) AND (SOFT
access)` becomes structurally enforced — the floor is declared once per
table, and every permissive on the table inherits the AND. Per
[ADR-0032](./adr/0032-restrictive-policy-support.md).

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

## Adoption vocabulary

The terms that make brownfield adoption legible — what guarddog sees in a
live database, how it classifies what's there, and the dispositions an
operator can pick per policy. Phase 1.5 ([ADR-0029](./adr/0029-handling-existing-rls-policies.md)
through [ADR-0032](./adr/0032-restrictive-policy-support.md)).

### `ownership comment`

A `COMMENT ON POLICY` value guarddog stamps on every policy it emits
(`prisma-guarddog:managed`), and that the `adopt` command stamps on
operator-acknowledged foreigns (`prisma-guarddog:ignore`). The drift
engine reads `pg_description` for these markers to distinguish
guarddog-managed policies from a consumer's pre-existing ones,
independent of the naming convention. The two markers are the durable,
out-of-band identity for guarddog's policies — surviving renames, schema
drift, or hand-edits in `pg_policies`.

### `drift`

The result of comparing guarddog's declared state against the live
database, scoped to the tables guarddog manages (the ones it enables RLS
on). Classifications, all keyed by `(table, policyName)`:

- **foreign** — a live policy on a managed table that guarddog neither
  declares nor marked. Permissive foreigns are wideners — the headline
  risk. `guarddog drift` reports them with `--exit-code` to gate CI.
- **staleManaged** — a `:managed`-stamped policy guarddog no longer
  declares (a prior-run orphan; safe to drop).
- **missing** — a policy guarddog declares that isn't in the live DB
  (not applied yet, or drifted away).
- **restrictivenessMismatch** — same `(table, name)` in both, but the
  declared `restrictive` flag disagrees with `pg_policies.permissive`.
  Treated as drift (forces a reapply) so the wrong kind doesn't ship
  silently.
- **acknowledged** — `:ignore`-stamped foreigns the operator kept via
  `adopt`. Reported for transparency; not flagged as drift.

### `adopt` / `disposition`

`guarddog adopt --against <url>` walks every `foreign` policy and prompts
for a per-policy **disposition**:

- **keep** — stamp `:ignore` so drift acknowledges it. Use for
  intentionally-out-of-scope policies (e.g., a Supabase auth policy you
  don't want guarddog managing).
- **remove** — emit `drop-policy` now. For policies you know are dead.
- **edit** — scaffold `.rawSql(<legacy>) + .named(<legacy>) + .todo()` to
  fold into `guarddog.ts`. Preserves the legacy SQL verbatim under the
  legacy name; the `.todo()` reminds you to replace with a typed
  predicate.
- **override** — scaffold a fresh `.todo()` stub under the legacy name;
  discards the legacy SQL. Use when the legacy is wrong but the name
  must stay.
- **skip** — leave alone; re-surface next run.

Per [ADR-0030](./adr/0030-interactive-adoption-triage.md). Pairs with
named-policy support so an `edit` scaffold can ship as an atomic in-place
upgrade.

### `declared name`

An optional override of guarddog's auto-generated policy name. Set via
`.named(name)` (chained, persists across subsequent verbs) or
`{ name }` per-verb (local, wins over chained). When set, the emitter
renders `DROP POLICY IF EXISTS <declared>; CREATE POLICY <declared> …`,
swapping a typed replacement in **atomically** under a legacy name with
no widening window. Lint warns on declared-name use to nudge authors
back to the auto-gen convention (`<table>_<role>_<command>`) once
adoption is complete — declared names are a transitional escape hatch,
not an aesthetic preference. Per
[ADR-0031](./adr/0031-user-declared-policy-names.md).
