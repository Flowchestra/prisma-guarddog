# @flowchestra/prisma-guarddog-importer-postgres

## 0.1.0-alpha.12

### Patch Changes

- Updated dependencies []:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.12

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

- Updated dependencies []:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.11

## 0.1.0-alpha.10

### Patch Changes

- Updated dependencies
  [[`b4186b3`](https://github.com/Flowchestra/prisma-guarddog/commit/b4186b32c8a3d3e35c902792c2efbc6d41277a9c)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.10

## 0.1.0-alpha.9

### Patch Changes

- Updated dependencies
  [[`0525a7e`](https://github.com/Flowchestra/prisma-guarddog/commit/0525a7e33b0732811fe0c004edfc008b68e9e4e5)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.9

## 0.1.0-alpha.8

### Patch Changes

- Updated dependencies
  [[`21ae5b6`](https://github.com/Flowchestra/prisma-guarddog/commit/21ae5b6110ff6715251bb0edcf60afffcbd7ce6a)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.8

## 0.1.0-alpha.6

### Patch Changes

- Updated dependencies
  [[`523d372`](https://github.com/Flowchestra/prisma-guarddog/commit/523d372c577ba32c14cf670dd9c2d53140bd6359)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.6

## 0.1.0-alpha.5

### Patch Changes

- Updated dependencies
  [[`753e022`](https://github.com/Flowchestra/prisma-guarddog/commit/753e0222b9aa4f4f2866b03965f7cb3c61d95718)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.5

## 0.1.0-alpha.4

### Patch Changes

- Updated dependencies
  [[`79fe642`](https://github.com/Flowchestra/prisma-guarddog/commit/79fe642f0d1d1f2bb0cdf470d7f944618245aa33)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.4

## 0.1.0-alpha.3

### Patch Changes

- Updated dependencies
  [[`106bb33`](https://github.com/Flowchestra/prisma-guarddog/commit/106bb3331ae14325ac320255d85b70ceda48a6d0)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.3

## 0.1.0-alpha.2

### Patch Changes

- Updated dependencies
  [[`2310dcf`](https://github.com/Flowchestra/prisma-guarddog/commit/2310dcf5cd4a8bd6a1da107c5b58837de26f8401)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.2

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

- Updated dependencies
  [[`678e840`](https://github.com/Flowchestra/prisma-guarddog/commit/678e840ccfbc5e4f614bddc0d7d062a60c0224f7)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.1

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
