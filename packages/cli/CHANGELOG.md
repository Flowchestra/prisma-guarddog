# @flowchestra/prisma-guarddog

## 0.1.0-alpha.14

### Minor Changes

- [`3ee711e`](https://github.com/Flowchestra/prisma-guarddog/commit/3ee711e328c601518c160b8aa2edde31aa404d4f)
  Thanks [@Henry-Steele](https://github.com/Henry-Steele)! - Add **restrictive
  policy support** for issue #26 (ADR-0032): a low-level
  `.restrictivePolicy(role).forAll(fn)` primitive and the domain-aware
  `.isolation(fn)` sugar that emits `<table>_isolation` as
  `AS RESTRICTIVE FOR ALL TO public`. Restrictive policies are AND'd with every
  permissive on the same table — an **inescapable floor**, so the tenant +
  soft-delete shape `(HARD floor) AND (SOFT access)` becomes structurally
  enforced instead of author-discipline-dependent. A future permissive
  break-glass policy cannot widen around the floor.

  ```ts
  // Recommended (90% case): one isolation floor per table.
  guard.model('Workspace').table('workspaces')
    .isolation((p) =>
      p.fn('current_tenant_id').eq(col('tenant_id')).and(p.raw('deleted_at IS NULL'))
    )
    .policy('app_user')
      .select((p) => /* access only — the floor is already AND'd */)

  // Low-level primitive — escape hatch for non-public roles or distinct floors.
  guard.model('Widget').restrictivePolicy('public')
    .forAll((p) => p.claim('tenantId').eq(col('tenant_id')), { name: 'tenant_isolation' })
  ```

  - **core**: `PolicyAst` gains `restrictive?: boolean`, `all?: AllSpec`,
    `isolation?: boolean`; `Verb` extends to include `'all'`. `PolicyOpRecord`
    gains `restrictive?: boolean`. New `ModelBuilder.restrictivePolicy(role)`
    returns a `RestrictivePolicyBuilder` with `.named()` / `.forAll(fn, opts?)`
    / `.todo()`. New `ModelBuilder.isolation(fn, opts?)` desugars to
    `.restrictivePolicy('public').forAll(fn, opts)` with the isolation auto-name
    `<table>_isolation`. `compileToOps` threads the new fields and
    `policyRecordsEqual` treats a permissive ↔ restrictive flip as drift
    (forcing drop+recreate).
  - **emitter-postgres-rls**: AST emitter renders
    `CREATE POLICY <name> ON <table> AS RESTRICTIVE FOR ALL TO <role> USING (...) WITH CHECK (...)`.
    Permissive emission unchanged (the default — no `AS PERMISSIVE` clause
    emitted to keep migrations stable). CLI `renderOps` does the same on the
    Op-based path.
  - **cli (drift)**: new `restrictivenessMismatch` classification on
    `PolicyDrift` reporting a declared/live permissive↔restrictive disagreement
    on the same `(table, name)`. `guarddog drift` prints it as a hard failure
    (forces a reapply).

  Pairs cleanly with ADR-0031: `.isolation(fn, { name: 'tenant_isolation' })`
  adopts a legacy hand-written restrictive in place atomically (DROP IF EXISTS +
  CREATE under the same name). Pairs with ADR-0026: the typical floor is
  `p.fn('current_tenant_id').eq(col('tenant_id')) AND p.col('deleted_at').isNull()`.

  Backward compatible — every existing policy stays permissive; nothing renames,
  no migration required.

### Patch Changes

- Updated dependencies
  [[`3ee711e`](https://github.com/Flowchestra/prisma-guarddog/commit/3ee711e328c601518c160b8aa2edde31aa404d4f)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.14
  - @flowchestra/prisma-guarddog-emitter-postgres-rls@0.1.0-alpha.14
  - @flowchestra/prisma-guarddog-emitter-postgres-column-privileges@0.1.0-alpha.14
  - @flowchestra/prisma-guarddog-importer-postgres@0.1.0-alpha.14
  - @flowchestra/prisma-guarddog-importer-prisma@0.1.0-alpha.14
  - @flowchestra/prisma-guarddog-lint@0.1.0-alpha.14

## 0.1.0-alpha.13

### Patch Changes

- Updated dependencies
  [[`6b7442b`](https://github.com/Flowchestra/prisma-guarddog/commit/6b7442b5ddcec0a0d1350710e53e4a47e4f9dad8)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.13
  - @flowchestra/prisma-guarddog-emitter-postgres-rls@0.1.0-alpha.13
  - @flowchestra/prisma-guarddog-lint@0.1.0-alpha.13
  - @flowchestra/prisma-guarddog-emitter-postgres-column-privileges@0.1.0-alpha.13
  - @flowchestra/prisma-guarddog-importer-postgres@0.1.0-alpha.13
  - @flowchestra/prisma-guarddog-importer-prisma@0.1.0-alpha.13

## 0.1.0-alpha.12

### Minor Changes

- [`a0f52e9`](https://github.com/Flowchestra/prisma-guarddog/commit/a0f52e94ec44c75fc5794eaf7e95904e4972811a)
  Thanks [@Henry-Steele](https://github.com/Henry-Steele)! - `guarddog adopt` —
  interactive, per-policy triage of the RLS policies already in a database
  (ADR-0030). Builds on the drift engine (ADR-0029) to turn adoption from
  all-or-nothing into a guided, auditable decision.

  For each **foreign** policy on a guarddog-managed table, pick a disposition:
  - **keep** — deliberately managed outside guarddog. Stamps
    `COMMENT ON POLICY … IS 'prisma-guarddog:ignore'`; `drift` then reports it
    as _acknowledged_ (not foreign) and `migrate --drop-unmanaged` never drops
    it. The decision lives in the catalog and travels with the database — no
    config file.
  - **remove** — `DROP POLICY` now.
  - **edit** — scaffold the policy as `rawSql(<legacy>) + .todo()` to refine
    into a typed predicate.
  - **override** — scaffold a fresh-author `.todo()` stub (legacy SQL
    discarded).
  - **skip** — decide later.

  ```sh
  guarddog adopt --against "$DATABASE_URL"            # interactive TTY prompt
  guarddog adopt --against "$DATABASE_URL" --out adopted.ts
  ```

  The decision logic is a pure `planAdoption` (keep-comments / drop ops /
  scaffold), with the prompt as a thin injectable shell — so it's unit-tested,
  and a docker e2e proves the keep/remove/edit dispositions land against real
  Postgres. `computePolicyDrift` gains an `acknowledged` classification for
  `:ignore`-marked policies. Conservative: `adopt` only writes the keep-marks
  and drops you confirm per policy, scoped to foreign policies on managed
  tables.

### Patch Changes

- Updated dependencies []:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.12
  - @flowchestra/prisma-guarddog-emitter-postgres-column-privileges@0.1.0-alpha.12
  - @flowchestra/prisma-guarddog-emitter-postgres-rls@0.1.0-alpha.12
  - @flowchestra/prisma-guarddog-importer-postgres@0.1.0-alpha.12
  - @flowchestra/prisma-guarddog-importer-prisma@0.1.0-alpha.12
  - @flowchestra/prisma-guarddog-lint@0.1.0-alpha.12

## 0.1.0-alpha.11

### Minor Changes

- [`60ae423`](https://github.com/Flowchestra/prisma-guarddog/commit/60ae423785fc065e1663d77a9d7d63eb4b084eaf)
  Thanks [@Henry-Steele](https://github.com/Henry-Steele)! - Handle pre-existing
  (foreign) RLS policies during adoption (ADR-0029). guarddog now detects,
  reports, and can cut over the hand-written policies already in a consumer's
  database — closing the silent hazard where a legacy permissive policy ORs with
  guarddog's and widens access (e.g. a `FOR ALL` policy leaking soft-deleted
  rows survives the migration).
  - **Ownership marker** — every emitted `CREATE POLICY` is stamped with
    `COMMENT ON POLICY … IS 'prisma-guarddog:managed'`, the durable catalog
    record drift detection reads to tell guarddog's policies from foreign ones.
  - **`guarddog drift --against <url>`** — compares the declared schema against
    the live database and reports, scoped to guarddog-managed tables:
    **foreign** policies (a consumer's own; permissive ones flagged as
    access-wideners), **stale-managed** (guarddog-marked but no longer
    declared), and **missing** (declared, not yet applied). `--exit-code` gates
    CI.
  - **`guarddog migrate --drop-unmanaged`** — opt-in cutover: reads the live
    inventory and prepends `DROP POLICY` for foreign/stale policies on managed
    tables, so the migration removes legacy policies before creating guarddog's.
    Default `migrate` is unchanged and never auto-drops a foreign policy.
  - **`readPolicyInventory`** (importer-postgres) — reads the live policy
    inventory (identity + permissive flag + ownership comment) from the
    `pg_policy` catalog.

  Conservative by default: the DB-touching paths (`--against`,
  `--drop-unmanaged`) are opt-in; nothing changes for existing users. Covered by
  unit tests + a docker e2e proving the legacy-leak → drift-flag → cutover →
  leak-gone flow against real Postgres.

### Patch Changes

- Updated dependencies
  [[`60ae423`](https://github.com/Flowchestra/prisma-guarddog/commit/60ae423785fc065e1663d77a9d7d63eb4b084eaf)]:
  - @flowchestra/prisma-guarddog-importer-postgres@0.1.0-alpha.11
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.11
  - @flowchestra/prisma-guarddog-emitter-postgres-column-privileges@0.1.0-alpha.11
  - @flowchestra/prisma-guarddog-emitter-postgres-rls@0.1.0-alpha.11
  - @flowchestra/prisma-guarddog-importer-prisma@0.1.0-alpha.11
  - @flowchestra/prisma-guarddog-lint@0.1.0-alpha.11

## 0.1.0-alpha.10

### Patch Changes

- Updated dependencies
  [[`b4186b3`](https://github.com/Flowchestra/prisma-guarddog/commit/b4186b32c8a3d3e35c902792c2efbc6d41277a9c)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.10
  - @flowchestra/prisma-guarddog-importer-prisma@0.1.0-alpha.10
  - @flowchestra/prisma-guarddog-emitter-postgres-column-privileges@0.1.0-alpha.10
  - @flowchestra/prisma-guarddog-emitter-postgres-rls@0.1.0-alpha.10
  - @flowchestra/prisma-guarddog-importer-postgres@0.1.0-alpha.10
  - @flowchestra/prisma-guarddog-lint@0.1.0-alpha.10

## 0.1.0-alpha.9

### Minor Changes

- [`0525a7e`](https://github.com/Flowchestra/prisma-guarddog/commit/0525a7e33b0732811fe0c004edfc008b68e9e4e5)
  Thanks [@Henry-Steele](https://github.com/Henry-Steele)! - CLI now reads
  `prisma.config.ts` for path discovery. The Prisma `schema` location and
  `migrations.path` feed guarddog's `prismaSchemaPath` / `migrationsDir`, so
  guarddog follows wherever you've put your Prisma schema and migrations instead
  of assuming `prisma/`.

  Resolution precedence (highest first): explicit `guarddog.config.ts` values →
  `prisma.config.ts` paths → conventional defaults (`prisma/schema.prisma`,
  `prisma/migrations/`). guarddog's own schema file (`prisma/guarddog.ts`) is
  not a `prisma.config.ts` concern and stays a guarddog convention /
  `guarddog.config.ts` override.

  Lenient by design: a present-but-unloadable `prisma.config.ts` warns and falls
  back to conventions rather than failing the command. Previously this was
  deferred to "Phase 2"; consumers with non-default Prisma layouts no longer
  need to restate those paths in `guarddog.config.ts`.

### Patch Changes

- Updated dependencies
  [[`0525a7e`](https://github.com/Flowchestra/prisma-guarddog/commit/0525a7e33b0732811fe0c004edfc008b68e9e4e5)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.9
  - @flowchestra/prisma-guarddog-emitter-postgres-column-privileges@0.1.0-alpha.9
  - @flowchestra/prisma-guarddog-emitter-postgres-rls@0.1.0-alpha.9
  - @flowchestra/prisma-guarddog-importer-postgres@0.1.0-alpha.9
  - @flowchestra/prisma-guarddog-importer-prisma@0.1.0-alpha.9
  - @flowchestra/prisma-guarddog-lint@0.1.0-alpha.9

## 0.1.0-alpha.8

### Patch Changes

- Updated dependencies
  [[`21ae5b6`](https://github.com/Flowchestra/prisma-guarddog/commit/21ae5b6110ff6715251bb0edcf60afffcbd7ce6a)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.8
  - @flowchestra/prisma-guarddog-emitter-postgres-column-privileges@0.1.0-alpha.8
  - @flowchestra/prisma-guarddog-emitter-postgres-rls@0.1.0-alpha.8
  - @flowchestra/prisma-guarddog-importer-postgres@0.1.0-alpha.8
  - @flowchestra/prisma-guarddog-importer-prisma@0.1.0-alpha.8
  - @flowchestra/prisma-guarddog-lint@0.1.0-alpha.8

## 0.1.0-alpha.7

### Patch Changes

- Updated dependencies
  [[`7037142`](https://github.com/Flowchestra/prisma-guarddog/commit/70371420f53db68b694984e67f8daa46dc0f67a1)]:
  - @flowchestra/prisma-guarddog-lint@0.1.0-alpha.7

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
