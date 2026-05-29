---
'@flowchestra/prisma-guarddog-core': minor
'@flowchestra/prisma-guarddog-emitter-postgres-rls': minor
'@flowchestra/prisma-guarddog': minor
---

`defineFunctions` — manage SQL helper functions as first-class emitted objects (#15, [ADR-0026](../docs/adr/0026-managed-sql-functions.md)).

guarddog now emits and diffs the `CREATE OR REPLACE FUNCTION` DDL, target schema, and `GRANT EXECUTE` for helper functions you'd otherwise inline (duplicated N×) or drop to unmanaged `p.raw(...)`. This resolves the ADR-0001 self-contained-emission tension by having guarddog *own* the functions rather than depend on external ones — bespoke authz logic (creator-implicit-OWNER, custom JOIN shapes, shared rank mappers) lives in one typed, versioned place.

**Declare** functions on the schema:

```ts
export default defineSchema({
  functions: defineFunctions({
    schema: 'app',
    fns: {
      resource_role_ordinal: {
        args: [{ name: 'role_text', type: 'text' }],
        returns: 'integer',
        volatility: 'immutable',
        body: `SELECT CASE role_text WHEN 'OWNER' THEN 4 ... END`,
      },
      user_has_workspace_grant: {
        args: [
          { name: 'workspace_id_in', type: 'text' },
          { name: 'user_id_in', type: 'text' },
          { name: 'min_role_in', type: 'text', default: 'NULL' },
        ],
        returns: 'boolean',
        volatility: 'stable',
        security: 'definer',
        searchPath: ['pg_catalog', 'public'],
        dependsOn: ['resource_role_ordinal'],
        grants: { execute: ['app_user', 'app_system'] },
        body: `SELECT EXISTS (...)`,
      },
    },
  }),
  policies(guard) { /* ... */ },
})
```

**Reference** a managed function from a policy with `p.fn(name, ...args)`:

```ts
.update({
  using: (p) => p.fn('user_has_workspace_grant', col('id'), p.claim('sub'), 'MANAGER'),
  check: (p) => p.fn('user_has_workspace_grant', col('id'), p.claim('sub'), 'MANAGER'),
})
```

The function name **autocompletes** against the declared `fns` keys and **arity is checked** — `TFunctions` threads from `defineFunctions` → `Guarddog` → the predicate builder (parallel to the `hasGrant` table-hint generic, #12). Args may be expressions (`col(...)`, `p.claim(...)`, nested `p.fn(...)`) or SQL literals. An unknown name or wrong arity is a compile-time type error. Per-argument PG-type checking is intentionally out of scope (ADR-0026) — `FluentExpr` is untyped at the SQL level.

**Signature-aware lifecycle.** `compileToOps` emits dependency-ordered `create-schema` / `create-function` / `grant-execute` ops; `diffStates` emits `CREATE OR REPLACE` for body/attribute changes and `DROP`+`CREATE`+re-`GRANT` only when the signature (arg names/types, return type) changes. `EXECUTE` grants also emit a once-per-`(schema, role)` `GRANT USAGE ON SCHEMA`.

Fully backward compatible: `functions` is optional and `TFunctions` defaults to unconstrained, so schemas without functions are unchanged.
