# @flowchestra/prisma-guarddog-core

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
