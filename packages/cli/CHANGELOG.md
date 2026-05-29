# @flowchestra/prisma-guarddog

## 0.1.0-alpha.6

### Minor Changes

- [`523d372`](https://github.com/Flowchestra/prisma-guarddog/commit/523d372c577ba32c14cf670dd9c2d53140bd6359)
  Thanks [@Henry-Steele](https://github.com/Henry-Steele)! - `defineFunctions` —
  manage SQL helper functions as first-class emitted objects (#15,
  [ADR-0026](../docs/adr/0026-managed-sql-functions.md)).

  guarddog now emits and diffs the `CREATE OR REPLACE FUNCTION` DDL, target
  schema, and `GRANT EXECUTE` for helper functions you'd otherwise inline
  (duplicated N×) or drop to unmanaged `p.raw(...)`. This resolves the ADR-0001
  self-contained-emission tension by having guarddog _own_ the functions rather
  than depend on external ones — bespoke authz logic (creator-implicit-OWNER,
  custom JOIN shapes, shared rank mappers) lives in one typed, versioned place.

  **Declare** functions on the schema:

  ```ts
  export default defineSchema({
    functions: defineFunctions({
      schema: "app",
      fns: {
        resource_role_ordinal: {
          args: [{ name: "role_text", type: "text" }],
          returns: "integer",
          volatility: "immutable",
          body: `SELECT CASE role_text WHEN 'OWNER' THEN 4 ... END`,
        },
        user_has_workspace_grant: {
          args: [
            { name: "workspace_id_in", type: "text" },
            { name: "user_id_in", type: "text" },
            { name: "min_role_in", type: "text", default: "NULL" },
          ],
          returns: "boolean",
          volatility: "stable",
          security: "definer",
          searchPath: ["pg_catalog", "public"],
          dependsOn: ["resource_role_ordinal"],
          grants: { execute: ["app_user", "app_system"] },
          body: `SELECT EXISTS (...)`,
        },
      },
    }),
    policies(guard) {
      /* ... */
    },
  });
  ```

  **Reference** a managed function from a policy with `p.fn(name, ...args)`:

  ```ts
  .update({
    using: (p) => p.fn('user_has_workspace_grant', col('id'), p.claim('sub'), 'MANAGER'),
    check: (p) => p.fn('user_has_workspace_grant', col('id'), p.claim('sub'), 'MANAGER'),
  })
  ```

  The function name **autocompletes** against the declared `fns` keys and
  **arity is checked** — `TFunctions` threads from `defineFunctions` →
  `Guarddog` → the predicate builder (parallel to the `hasGrant` table-hint
  generic, #12). Args may be expressions (`col(...)`, `p.claim(...)`, nested
  `p.fn(...)`) or SQL literals. An unknown name or wrong arity is a compile-time
  type error. Per-argument PG-type checking is intentionally out of scope
  (ADR-0026) — `FluentExpr` is untyped at the SQL level.

  **Signature-aware lifecycle.** `compileToOps` emits dependency-ordered
  `create-schema` / `create-function` / `grant-execute` ops; `diffStates` emits
  `CREATE OR REPLACE` for body/attribute changes and `DROP`+`CREATE`+re-`GRANT`
  only when the signature (arg names/types, return type) changes. `EXECUTE`
  grants also emit a once-per-`(schema, role)` `GRANT USAGE ON SCHEMA`.

  Fully backward compatible: `functions` is optional and `TFunctions` defaults
  to unconstrained, so schemas without functions are unchanged.

### Patch Changes

- Updated dependencies
  [[`523d372`](https://github.com/Flowchestra/prisma-guarddog/commit/523d372c577ba32c14cf670dd9c2d53140bd6359)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.6
  - @flowchestra/prisma-guarddog-emitter-postgres-rls@0.1.0-alpha.6
  - @flowchestra/prisma-guarddog-emitter-postgres-column-privileges@0.1.0-alpha.6
  - @flowchestra/prisma-guarddog-importer-postgres@0.1.0-alpha.6
  - @flowchestra/prisma-guarddog-importer-prisma@0.1.0-alpha.6
  - @flowchestra/prisma-guarddog-lint@0.1.0-alpha.6

## 0.1.0-alpha.5

### Patch Changes

- Updated dependencies
  [[`753e022`](https://github.com/Flowchestra/prisma-guarddog/commit/753e0222b9aa4f4f2866b03965f7cb3c61d95718)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.5
  - @flowchestra/prisma-guarddog-emitter-postgres-column-privileges@0.1.0-alpha.5
  - @flowchestra/prisma-guarddog-emitter-postgres-rls@0.1.0-alpha.5
  - @flowchestra/prisma-guarddog-importer-postgres@0.1.0-alpha.5
  - @flowchestra/prisma-guarddog-importer-prisma@0.1.0-alpha.5
  - @flowchestra/prisma-guarddog-lint@0.1.0-alpha.5

## 0.1.0-alpha.4

### Patch Changes

- Updated dependencies
  [[`79fe642`](https://github.com/Flowchestra/prisma-guarddog/commit/79fe642f0d1d1f2bb0cdf470d7f944618245aa33)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.4
  - @flowchestra/prisma-guarddog-emitter-postgres-rls@0.1.0-alpha.4
  - @flowchestra/prisma-guarddog-emitter-postgres-column-privileges@0.1.0-alpha.4
  - @flowchestra/prisma-guarddog-importer-postgres@0.1.0-alpha.4
  - @flowchestra/prisma-guarddog-importer-prisma@0.1.0-alpha.4
  - @flowchestra/prisma-guarddog-lint@0.1.0-alpha.4

## 0.1.0-alpha.3

### Minor Changes

- [`106bb33`](https://github.com/Flowchestra/prisma-guarddog/commit/106bb3331ae14325ac320255d85b70ceda48a6d0)
  Thanks [@Henry-Steele](https://github.com/Henry-Steele)! - Grant-table
  extensions + override ergonomics, from the Flowchestra pilot (issues #5–#9).

  **Rank-based grants** (#5,
  [ADR-0022](../docs/adr/0022-rank-based-grant-tables.md)) — a third action
  shape on `tables` / `fallbackTable` alongside `actionsColumn` /
  `actionColumn`:

  ```ts
  tables: {
    workspaceId: {
      name: 'workspace_grants',
      principalColumn: 'user_id',
      roleColumn: 'role',
      roleHierarchy: ['READER', 'EDITOR', 'MANAGER', 'OWNER'],
      roleColumnType: '"ResourceRole"', // optional enum cast
    },
  }
  ```

  `p.hasGrant('EDITOR', col('workspaceId'))` compiles to
  `role = ANY(ARRAY['EDITOR','MANAGER','OWNER']::"ResourceRole"[])` — "at least
  rank EDITOR".

  **Principal disjunction** (#6,
  [ADR-0023](../docs/adr/0023-grant-principal-disjunction.md)) — grants that
  match by user OR group:

  ```ts
  {
    principalUserColumn: 'user_id',
    principalGroupColumn: 'group_id',
    groupMemberTable: { name: 'org_group_members', userColumn: 'user_id', groupColumn: 'group_id' },
  }
  ```

  emits
  `(user_id = <principal> OR group_id IN (SELECT group_id FROM org_group_members WHERE user_id = <principal>))`.
  `principalColumn` remains a backward-compatible alias for
  `principalUserColumn`. Rank and disjunction compose on the same table.

  **`principalClaim` on `source: 'claims'`** (#7) — both
  `ResourceGrantsDefinition` variants now carry `principalClaim` (default
  `'sub'`), so `compileHasGrant` overrides read it from `ctx` instead of
  hardcoding.

  **CLI-threaded render overrides** (#8,
  [ADR-0024](../docs/adr/0024-config-threaded-render-overrides.md)) —
  `guarddog.config.ts` accepts `renderOverrides` (the four compiler functions);
  `guarddog migrate` / `diff` / `emit` thread them into `renderOps`. Consumers
  with custom authz no longer reimplement the migrate pipeline.

  **Re-exported compiler types** (#9) — `HasGrantCompiler`,
  `HasAppRoleCompiler`, `HasResourcePermissionCompiler`, `IsOwnerCompiler`, and
  the new `RenderOverrides` are exported from `@flowchestra/prisma-guarddog`.

  **Breaking (minor, alpha line):** `ResourceGrantsDefinition`'s claims variant
  now requires `principalClaim` post-construction; code constructing the type by
  hand (rather than via `defineResourceGrants`) must add it. Caught by `tsgo`.

### Patch Changes

- Updated dependencies
  [[`106bb33`](https://github.com/Flowchestra/prisma-guarddog/commit/106bb3331ae14325ac320255d85b70ceda48a6d0)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.3
  - @flowchestra/prisma-guarddog-emitter-postgres-rls@0.1.0-alpha.3
  - @flowchestra/prisma-guarddog-emitter-postgres-column-privileges@0.1.0-alpha.3
  - @flowchestra/prisma-guarddog-importer-postgres@0.1.0-alpha.3
  - @flowchestra/prisma-guarddog-importer-prisma@0.1.0-alpha.3
  - @flowchestra/prisma-guarddog-lint@0.1.0-alpha.3

## 0.1.0-alpha.2

### Patch Changes

- Updated dependencies
  [[`2310dcf`](https://github.com/Flowchestra/prisma-guarddog/commit/2310dcf5cd4a8bd6a1da107c5b58837de26f8401)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.2
  - @flowchestra/prisma-guarddog-emitter-postgres-rls@0.1.0-alpha.2
  - @flowchestra/prisma-guarddog-emitter-postgres-column-privileges@0.1.0-alpha.2
  - @flowchestra/prisma-guarddog-importer-postgres@0.1.0-alpha.2
  - @flowchestra/prisma-guarddog-importer-prisma@0.1.0-alpha.2
  - @flowchestra/prisma-guarddog-lint@0.1.0-alpha.2

## 0.1.0-alpha.1

### Minor Changes

- [`678e840`](https://github.com/Flowchestra/prisma-guarddog/commit/678e840ccfbc5e4f614bddc0d7d062a60c0224f7)
  Thanks [@Henry-Steele](https://github.com/Henry-Steele)! - CLI: add `emit`,
  `diff`, `import` subcommands and a `--lint` flag on `check`.
  - `guarddog emit` — render the entire schema as SQL to stdout (or
    `--out <file>`). Read-only; touches no migrations. Useful for ad-hoc
    inspection or piping the full Op set into psql.
  - `guarddog diff` — preview what the next `guarddog migrate` would write,
    without writing anything. Pass `--exit-code` to fail when there are pending
    changes (CI drift gate).
  - `guarddog import` — connect to a live Postgres (`--url <conn-string>`) and
    scaffold a `guarddog.ts` from `pg_policies` + column privileges. Output uses
    `rawSql()` + `.todo()` markers per ADR-0012; review before committing.
    Requires `pg` (declared as an optional peerDependency).
  - `guarddog check --lint` — cross-reference the loaded `Guarddog` against the
    consumer's Prisma DMMF and fail on any model without `.policy()` /
    `.polymorphic()` / `.noPolicy()` coverage. The bug class RLS itself cannot
    catch.

  Each command has a matching programmatic export — `runEmit`, `runDiff`,
  `runImport` — for editor integrations and scripting.

### Patch Changes

- [`678e840`](https://github.com/Flowchestra/prisma-guarddog/commit/678e840ccfbc5e4f614bddc0d7d062a60c0224f7)
  Thanks [@Henry-Steele](https://github.com/Henry-Steele)! - Two bug fixes
  surfaced by running the end-to-end suite for the first time.

  **All packages:** add a `default` condition to every workspace package's
  `exports` field. Previously only `types` + `import` were declared — jiti (used
  by the CLI's `loadSchema`) requests the `default` condition during
  CJS-flavored resolution, so any `prisma/guarddog.ts` that lived outside the
  workspace tree failed to load workspace packages with
  `No "exports" main defined`. This was a latent bug for every downstream
  consumer; surfaced when the `guarddog` CLI was pointed at a schema file in a
  tmpdir.

  **`importer-postgres`:** correctly parse `pg_policies.roles` when
  node-postgres returns the `name[]` column as a raw Postgres array literal
  (`{role1,role2}`) instead of a JS array. The previous code did
  `[...row.roles]`, which spread the string to characters and made
  `dbRole === '{'` for every imported policy. A new `parseRolesField` helper
  accepts both shapes and handles double-quoted entries.

- Updated dependencies
  [[`678e840`](https://github.com/Flowchestra/prisma-guarddog/commit/678e840ccfbc5e4f614bddc0d7d062a60c0224f7)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.1
  - @flowchestra/prisma-guarddog-emitter-postgres-rls@0.1.0-alpha.1
  - @flowchestra/prisma-guarddog-emitter-postgres-column-privileges@0.1.0-alpha.1
  - @flowchestra/prisma-guarddog-importer-prisma@0.1.0-alpha.1
  - @flowchestra/prisma-guarddog-importer-postgres@0.1.0-alpha.1
  - @flowchestra/prisma-guarddog-lint@0.1.0-alpha.1

## 0.1.0-alpha.0

### Minor Changes

- Initial internal alpha release.

  Phase 1 implementation complete: schema-driven DSL (`defineSchema`,
  three-permission-layer primitives, fluent predicate builder), Op-union compile
  pipeline (`compileToOps`, `diffStates`, sidecar forward-replay), CLI
  (`guarddog check` / `migrate` plus the `prisma-guarddog-generator` Prisma
  generator binary), scaffold-mode `pg_policies` importer, real-Postgres
  verification harness, coverage lint, and the Flowchestra preset. See
  [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) for the system overview.

  Pre-release: end-to-end semantic verification against real Postgres is still
  gated behind `GUARDDOG_E2E=1`; rendered SQL has been validated only via the
  unit test suite (374 tests). Expect breaking changes through the `0.1.x` alpha
  line.

### Patch Changes

- Updated dependencies []:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.0
  - @flowchestra/prisma-guarddog-emitter-postgres-rls@0.1.0-alpha.0
  - @flowchestra/prisma-guarddog-emitter-postgres-column-privileges@0.1.0-alpha.0
  - @flowchestra/prisma-guarddog-importer-prisma@0.1.0-alpha.0
  - @flowchestra/prisma-guarddog-importer-postgres@0.1.0-alpha.0
  - @flowchestra/prisma-guarddog-lint@0.1.0-alpha.0
