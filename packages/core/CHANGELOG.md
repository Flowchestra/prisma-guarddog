# @flowchestra/prisma-guarddog-core

## 0.1.0-alpha.11

## 0.1.0-alpha.10

### Minor Changes

- [`b4186b3`](https://github.com/Flowchestra/prisma-guarddog/commit/b4186b32c8a3d3e35c902792c2efbc6d41277a9c)
  Thanks [@Henry-Steele](https://github.com/Henry-Steele)! - Typed `model()` +
  new `p.col()` autocomplete (ADR-0028). Model names and column references are
  now type-checked against your Prisma schema, sourced from DMMF — typos become
  compile errors instead of apply-time Postgres errors.

  The Prisma generator now emits a `ModelColumns` const (model → SQL columns,
  from DMMF `dbName`, relations excluded) alongside `Models`/`ModelTables`. Pass
  it to `defineSchema` and the model + column unions are **inferred** (no
  explicit generic):

  ```ts
  import { ModelColumns } from "./generated/guarddog-models";

  export default defineSchema({
    models: ModelColumns,
    // ...
    policies(guard) {
      guard
        .model("Workspace") // ← autocompletes model names; typo = type error
        .policy("app_user")
        .select(p => p.col("tenantId").eq(p.claim("tenantId"))); // ← p.col autocompletes Workspace's columns
    },
  });
  ```

  - **`p.col(name)`** — model-scoped, typed column reference; returns a
    `FluentExpr` (drop-in: `p.col('x').eq(…)`,
    `p.hasGrant('read', p.col('workspaceId'))`). The standalone `col(...)` stays
    as the untyped escape hatch for dynamic/raw column names.
  - **`guard.model(name)`** and polymorphic `target(value, { model })` are typed
    against the model-name union.
  - Columns use the SQL `dbName` (post-`@map`/`@@map`) — correct for a SQL
    policy tool.
  - Fully backward compatible: omit `models` and `model()` / `p.col()` stay
    unconstrained (`string`); purely additive at runtime.

## 0.1.0-alpha.9

### Patch Changes

- [`0525a7e`](https://github.com/Flowchestra/prisma-guarddog/commit/0525a7e33b0732811fe0c004edfc008b68e9e4e5)
  Thanks [@Henry-Steele](https://github.com/Henry-Steele)! - Fix
  `p.fn(name, ...args)` crashing with `s.replace is not a function` on
  `emit`/`diff`/`migrate` when the schema is loaded via the CLI (jiti) and the
  call has one or more arguments (#19).

  `fnArgToExpr` discriminated arguments with `instanceof FluentExpr`. When the
  CLI loads `guarddog.ts` via jiti, the consumer's `col(...)` is a `FluentExpr`
  from jiti's module instance while the predicate builder runs in the CLI's
  instance — so `instanceof` is false across that realm boundary, and a
  `col(...)`/built-expression argument was mis-wrapped as a `literal` whose
  value was the `FluentExpr` object, then blew up in
  `formatLiteral`/`quoteString`. Zero-arg calls never hit the argument path,
  which is why they worked.

  Now discriminates by duck-typing on `.ast` (the same way every other builder
  method handles `FluentExpr` arguments), so `p.fn` with arguments compiles
  correctly regardless of module-instance boundaries. Covered by a new full-CLI
  (jiti `loadSchema` → `emit`) regression test.

## 0.1.0-alpha.8

### Patch Changes

- [`21ae5b6`](https://github.com/Flowchestra/prisma-guarddog/commit/21ae5b6110ff6715251bb0edcf60afffcbd7ce6a)
  Thanks [@Henry-Steele](https://github.com/Henry-Steele)! - Adopt lockstep
  versioning. All `@flowchestra/*` packages are now a changesets `fixed` group,
  so they version and publish together at a single shared version from here on.

  This realigns the suite after an alpha.6/alpha.7 split: two features (managed
  functions, then the column-privilege lint warning) released in two separate
  passes, leaving `@flowchestra/prisma-guarddog` + `…-lint` at alpha.7 and the
  rest at alpha.6. With the fixed group, this release brings every package up to
  the same alpha line.

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

## 0.1.0-alpha.5

### Minor Changes

- [`753e022`](https://github.com/Flowchestra/prisma-guarddog/commit/753e0222b9aa4f4f2866b03965f7cb3c61d95718)
  Thanks [@Henry-Steele](https://github.com/Henry-Steele)! - Type-safe
  autocomplete for the `hasGrant` table hint (#12, follow-up to ADR-0025).

  The `opts.table` hint added in alpha.4 was a plain `string`. It's now
  type-checked against the declared `tables` keys: valid keys autocomplete,
  typos are compile errors.

  ```ts
  const guard = new Guarddog({
    // ...
    resourceGrants: defineResourceGrants({
      source: "table",
      actions: ["READER", "EDITOR"] as const,
      tables: {
        workspaceId: {
          name: "workspace_grants",
          principalColumn: "user_id",
          actionsColumn: "actions",
        },
        workbenchId: {
          name: "workbench_grants",
          principalColumn: "user_id",
          actionsColumn: "actions",
        },
      },
    }),
  });

  guard
    .model("Workspace")
    .policy("app_user")
    .select(p => p.hasGrant("READER", col("id"), { table: "workspaceId" })); // ✓ autocompletes
  guard
    .model("Workbench")
    .policy("app_user")
    .select(p => p.hasGrant("READER", col("id"), { table: "typo" })); // ✗ type error
  ```

  Implemented by threading a `TGrantTableKeys` generic (inferred from the
  `tables` map keys) from `defineResourceGrants` → `Guarddog` →
  `PredicateBuilder` and the builder hierarchy. Fully backward compatible: the
  generic defaults to `string`, so claims-source schemas, schemas without a
  table source, and any existing call site stay unconstrained (any-string hint
  accepted, no narrowing). Verified by `@ts-expect-error` type-level tests that
  only pass type-check when the narrowing is live.

  Core-only change — the emitter and CLI reference `ResourceGrantsDefinition`
  without type arguments, so the new generic defaults there and they're
  unaffected.

## 0.1.0-alpha.4

### Minor Changes

- [`79fe642`](https://github.com/Flowchestra/prisma-guarddog/commit/79fe642f0d1d1f2bb0cdf470d7f944618245aa33)
  Thanks [@Henry-Steele](https://github.com/Henry-Steele)! - `hasGrant` per-call
  table hint (issue #11,
  [ADR-0025](../docs/adr/0025-hasgrant-per-call-table-hint.md)).

  `p.hasGrant(action, scopeColumn, { table })` routes to an explicit
  `tables`-map key, disambiguating two policies that check the same scope column
  against different grant tables — the own-row case where both Workspace and
  Workbench policies use `col('id')`:

  ```ts
  guard
    .model("Workspace")
    .policy("app_user")
    .select(p => p.hasGrant("READER", col("id"), { table: "workspaceId" })); // → workspace_grants
  guard
    .model("Workbench")
    .policy("app_user")
    .select(p => p.hasGrant("READER", col("id"), { table: "workbenchId" })); // → workbench_grants
  ```

  Omitting `opts.table` preserves the existing scope-column-name routing exactly
  — fully backward compatible. An unknown hint throws at compile time, listing
  the declared keys. The hint routes to `tables` only (not `fallbackTable`).

  `opts.table` is currently a validated `string`; type-safe autocomplete on the
  key is a tracked alpha.5 follow-up (it requires a DSL-wide generics thread,
  decoupled so the behavior ships now without the inference risk).

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

## 0.1.0-alpha.2

### Minor Changes

- [`2310dcf`](https://github.com/Flowchestra/prisma-guarddog/commit/2310dcf5cd4a8bd6a1da107c5b58837de26f8401)
  Thanks [@Henry-Steele](https://github.com/Henry-Steele)! - Add
  `source: 'table'` to `defineResourceGrants` (pulled forward from Phase 2).

  Previously `defineResourceGrants` only supported `source: 'claims'` — grants
  encoded as a JSONB blob in the session JWT. Now consumers who store grants in
  Postgres tables can author policies natively:

  ```ts
  defineResourceGrants({
    source: "table",
    actions: ["edit", "admin"] as const,

    // Per-scope-column overrides. The call `p.hasGrant('edit', col('workspaceId'))`
    // looks up `tables['workspaceId']` and emits EXISTS against that table.
    tables: {
      workspaceId: {
        name: "workspace_grant",
        principalColumn: "userId",
        actionsColumn: "actions", // text[]
        // OR actionColumn: 'action' for one row per action
      },
      workbenchId: {
        name: "workbench_grant",
        principalColumn: "userId",
        actionsColumn: "actions",
      },
    },

    // Polymorphic catch-all. Used when no per-resource entry matches.
    fallbackTable: {
      name: "resource_grant",
      principalColumn: "userId",
      resourceTypeColumn: "resourceType",
      resourceIdColumn: "resourceId",
      actionsColumn: "actions",
      scopeColumnTypeMap: { tenantId: "Tenant", orgId: "Org" },
    },

    principalClaim: "sub", // default
  });
  ```

  **New exports**
  - `@flowchestra/prisma-guarddog-core`: `PerResourceGrantTable`,
    `PolymorphicGrantTable` types.
  - `@flowchestra/prisma-guarddog-emitter-postgres-rls`:
    `defaultCompileHasGrantTable` — the built-in compiler used when
    `source: 'table'`.

  **Dispatch order** for `p.hasGrant('action', col('scopeColumn'))`:
  1. Explicit `ctx.compileHasGrant` override (when set) — always wins.
  2. `tables[scopeColumn]` — per-resource override.
  3. `fallbackTable` + `scopeColumnTypeMap[scopeColumn]` — polymorphic.
  4. Throw at compile time with an actionable error (no silent always-denies
     bugs).

  **Breaking change** (minor — we're in `0.1.x` alpha):
  `ResourceGrantsDefinition` is now a discriminated union by `source`. Code that
  read `.claimPath` unconditionally must narrow:
  `if (rg.source === 'claims') { ... }`. Caught by `tsgo`.

  See [ADR-0021](../docs/adr/0021-table-backed-resource-grants.md) for the full
  design rationale.

## 0.1.0-alpha.1

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
