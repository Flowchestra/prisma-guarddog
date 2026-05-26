# @flowchestra/prisma-guarddog-core

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
