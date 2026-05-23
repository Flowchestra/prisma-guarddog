# Glossary

Terminology in `prisma-guarddog`. **Discipline here is load-bearing** — same word, different concept, different code path. Conflating these is a footgun (see [ADR-0003](./adr/0003-four-primitive-split.md)).

## The four primitives

### `dbRole`

A Postgres database role, created via `CREATE ROLE`. Examples: `app_user`, `app_system`. dbRoles are the principals against which RLS policies are emitted (`FOR ALL TO app_user`).

**dbRole inheritance** is structural inheritance between Postgres roles (`CREATE ROLE app_system INHERIT IN ROLE app_user`). This is **not** the same as resource-scope cascade.

### `businessRole`

An application-level role, expressed as a string in the user's claims. Examples: `workspace.admin`, `workbench.editor`, `org.viewer`. businessRoles are referenced inside policy predicates via `claim.hasRole('workspace.admin', col('workspaceId'))`.

businessRoles are **not** Postgres roles. They are evaluated by predicates inside `USING` / `WITH CHECK` clauses, against the JWT claims set in the session.

### `resource`

A node in the resource tree (Tenant → Org → Workspace → Workbench). Resources are declared via `guard.resources({...})` and define which model corresponds to each level, how to traverse parent/child relationships, and which column references which scope.

**Resource-scope cascade** means a grant at one resource level (e.g., `workspace.admin` on workspace `W`) propagates to its children (every workbench within `W`). The emitter walks the resource tree to generate per-table policies.

### `grant`

A principal/action/resource record. A grant is the result of attaching a `businessRole` (or `dbRole`) to a `resource` via a predicate. Grants are not stored anywhere by guarddog — they're evaluated at query time by Postgres against the session's claims. Guarddog emits the policies that perform the evaluation.

## Other vocabulary

### `policy`

A Postgres RLS policy: a named rule attached to a table for a verb (`SELECT`/`INSERT`/`UPDATE`/`DELETE`/`ALL`) with `USING` and/or `WITH CHECK` predicates. Authored via `guard.model(X).policy(role).select(...)` etc.

### `predicate`

A boolean expression evaluated at query time inside a policy's `USING` or `WITH CHECK` clause. Built from claim accessors (`claim.tenantId`), column references (`col('tenantId')`), and combinators (`.and()` / `.or()` / `.not()`).

### `claim`

A field in the JWT (or other session-stamped data) accessible inside policies via `current_setting('request.jwt.claims', true)::json ->> 'fieldName'`. The claim schema is declared once via `defineClaims({ shape: ... })`.

### `columnPrivilege`

A static Postgres column-level grant: `GRANT SELECT(api_key) ON workbenches TO app_system`. Role-based, **not** row-conditional. Phase 1 covers this.

### `mask` / `projection`

**Phase 2.** A row-conditional field-visibility mechanism — different rows show different fields based on a predicate. Implemented via generated secure views or projection functions. **Distinct from `columnPrivilege`**, which is static per-role (see [ADR-0004](./adr/0004-column-privileges-vs-row-conditional-masking.md)).

### `sidecar`

A `guarddog.json` file colocated with a `migration.sql` in `prisma/migrations/<timestamp>_<name>/`. Contains the ops log for that migration. Forward-replaying all sidecars in `_prisma_migrations` ledger order derives the currently-deployed policy state (see [ADR-0006](./adr/0006-sidecar-migration-metadata.md), [ADR-0007](./adr/0007-forward-replay-state-derivation.md)).

### `polymorphic grant`

A grant declared once against a logical entity (e.g., `ScopeTarget`) and emitted as per-target policies via a discriminator column. Authored via `guard.polymorphic('ScopeTarget').discriminatedBy('targetType').targets({...}).grant(...)`.

### `scaffold-mode import`

The only mode the importer operates in. Reads `pg_policies` + column privileges from a live database and emits TS files with `rawSql()` + `.todo()` placeholders, plus `noPolicy()` stubs for any uncovered models. The importer **never** attempts to reverse-engineer business intent from SQL — SQL is evidence, not gospel (see [ADR-0012](./adr/0012-scaffold-only-importer.md)).
