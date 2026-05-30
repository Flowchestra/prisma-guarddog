# @flowchestra/prisma-guarddog-lint

## 0.1.0-alpha.14

### Patch Changes

- Updated dependencies
  [[`3ee711e`](https://github.com/Flowchestra/prisma-guarddog/commit/3ee711e328c601518c160b8aa2edde31aa404d4f)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.14
  - @flowchestra/prisma-guarddog-importer-prisma@0.1.0-alpha.14

## 0.1.0-alpha.13

### Minor Changes

- [`6b7442b`](https://github.com/Flowchestra/prisma-guarddog/commit/6b7442b5ddcec0a0d1350710e53e4a47e4f9dad8)
  Thanks [@Henry-Steele](https://github.com/Henry-Steele)! - Opt-in
  **user-declared policy names** for transitional legacy adoption (ADR-0031,
  issue #25). Closes the additive cutover window: a typed replacement under a
  legacy name renders `DROP POLICY IF EXISTS <legacy>; CREATE POLICY <legacy> …`
  and upgrades the policy in place, atomically — no widening from the OR'd
  permissive coexistence the auto-gen names would otherwise create.

  Two builder shapes, both supported:

  ```ts
  // Per-verb option — local, primitive, wins if both set.
  guard.model('Workspace').policy('app_user')
    .select((p) => p.claim('tenantId').eq(col('tenantId')), { name: 'workspaces_visibility_select' })

  // Chained `.named()` — persists across subsequent verbs; `.named(undefined)` resets;
  // a fresh `.policy()` also resets.
  guard.model('Workspace').policy('app_user')
    .named('workspaces_visibility_select')
    .select((p) => …)
    .insert({ check: (p) => …, name: 'workspaces_visibility_insert' })  // per-verb wins
    .update({ using: …, check: … })                                      // still 'workspaces_visibility_select'
  ```

  Resolution: per-verb `{ name }` > chained `.named()` > auto-gen
  `<table>_<role>_<command>`.
  - **core**: `name?: string` on `Select/Insert/Update/Delete` specs;
    `PolicyBuilder.named()` + per-verb option; same on polymorphic-target
    builders. `compileToOps` threads the declared name into the policy Op and
    rejects two policies sharing `(table, name)` at compile time (Postgres would
    catch it at apply; compile-time error is a better signal).
  - **emitter-postgres-rls**: AST-based `emitPolicy` / `emitPolymorphic` resolve
    `spec.name ?? policyName(...)` for both `DROP POLICY IF EXISTS` and
    `CREATE POLICY` — the Op-based `renderOps` path already used the Op's name
    unchanged.
  - **lint**: new `policy-uses-declared-name` warning (non-failing) for every
    verb spec carrying a declared name, surfacing the auto-gen target so authors
    converge on the convention once adoption is complete.

  Backward compatible — every consumer who doesn't pass a name gets the existing
  auto-gen behavior unchanged. The lint warning is the durable nudge: declared
  names are a transitional escape hatch, not an aesthetic preference. Pairs
  naturally with `guarddog adopt --edit` (ADR-0030), which scaffolds
  `rawSql(<legacy>) + .todo()` under the legacy name; once the typed predicate
  replaces the rawSql, the emit upgrades the legacy policy in place.

### Patch Changes

- Updated dependencies
  [[`6b7442b`](https://github.com/Flowchestra/prisma-guarddog/commit/6b7442b5ddcec0a0d1350710e53e4a47e4f9dad8)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.13
  - @flowchestra/prisma-guarddog-importer-prisma@0.1.0-alpha.13

## 0.1.0-alpha.12

### Patch Changes

- Updated dependencies []:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.12
  - @flowchestra/prisma-guarddog-importer-prisma@0.1.0-alpha.12

## 0.1.0-alpha.11

### Patch Changes

- Updated dependencies []:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.11
  - @flowchestra/prisma-guarddog-importer-prisma@0.1.0-alpha.11

## 0.1.0-alpha.10

### Patch Changes

- Updated dependencies
  [[`b4186b3`](https://github.com/Flowchestra/prisma-guarddog/commit/b4186b32c8a3d3e35c902792c2efbc6d41277a9c)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.10
  - @flowchestra/prisma-guarddog-importer-prisma@0.1.0-alpha.10

## 0.1.0-alpha.9

### Patch Changes

- Updated dependencies
  [[`0525a7e`](https://github.com/Flowchestra/prisma-guarddog/commit/0525a7e33b0732811fe0c004edfc008b68e9e4e5)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.9
  - @flowchestra/prisma-guarddog-importer-prisma@0.1.0-alpha.9

## 0.1.0-alpha.8

### Patch Changes

- Updated dependencies
  [[`21ae5b6`](https://github.com/Flowchestra/prisma-guarddog/commit/21ae5b6110ff6715251bb0edcf60afffcbd7ce6a)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.8
  - @flowchestra/prisma-guarddog-importer-prisma@0.1.0-alpha.8

## 0.1.0-alpha.7

### Minor Changes

- [`7037142`](https://github.com/Flowchestra/prisma-guarddog/commit/70371420f53db68b694984e67f8daa46dc0f67a1)
  Thanks [@Henry-Steele](https://github.com/Henry-Steele)! - Add a
  `column-privilege-unenforced` coverage-lint warning (#2,
  [ADR-0027](../docs/adr/0027-column-privilege-enforcement-gap.md)).

  `.columnPrivileges()` emits only the column-level `GRANT`s — it does **not**
  restrict access on its own. A column `GRANT` doesn't override a table-level
  `GRANT` (effective access is `table-level OR column-level`), so a pre-existing
  table-wide grant or a PUBLIC default silently supersedes the "restriction."
  The compiled SQL looks complete; only an e2e test reveals the column is still
  readable.

  `lintCoverage` now emits a non-failing `warning` for every model carrying
  `columnPrivileges`, explaining the gap and the interim requirement (withhold
  table-level privileges / grant only the allowed columns until guarddog manages
  base-table grants). `guarddog check --lint` and editor extensions surface it.
  Changes no emitted SQL — zero blast radius.

  The full fix (guarddog owning base-table grant posture + the table column
  universe via DMMF, so it can emit `REVOKE`-table + per-column re-`GRANT`) is
  scoped in ADR-0027 and deferred to its own release.

## 0.1.0-alpha.6

### Patch Changes

- Updated dependencies
  [[`523d372`](https://github.com/Flowchestra/prisma-guarddog/commit/523d372c577ba32c14cf670dd9c2d53140bd6359)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.6
  - @flowchestra/prisma-guarddog-importer-prisma@0.1.0-alpha.6

## 0.1.0-alpha.5

### Patch Changes

- Updated dependencies
  [[`753e022`](https://github.com/Flowchestra/prisma-guarddog/commit/753e0222b9aa4f4f2866b03965f7cb3c61d95718)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.5
  - @flowchestra/prisma-guarddog-importer-prisma@0.1.0-alpha.5

## 0.1.0-alpha.4

### Patch Changes

- Updated dependencies
  [[`79fe642`](https://github.com/Flowchestra/prisma-guarddog/commit/79fe642f0d1d1f2bb0cdf470d7f944618245aa33)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.4
  - @flowchestra/prisma-guarddog-importer-prisma@0.1.0-alpha.4

## 0.1.0-alpha.3

### Patch Changes

- Updated dependencies
  [[`106bb33`](https://github.com/Flowchestra/prisma-guarddog/commit/106bb3331ae14325ac320255d85b70ceda48a6d0)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.3
  - @flowchestra/prisma-guarddog-importer-prisma@0.1.0-alpha.3

## 0.1.0-alpha.2

### Patch Changes

- Updated dependencies
  [[`2310dcf`](https://github.com/Flowchestra/prisma-guarddog/commit/2310dcf5cd4a8bd6a1da107c5b58837de26f8401)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.2
  - @flowchestra/prisma-guarddog-importer-prisma@0.1.0-alpha.2

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
  - @flowchestra/prisma-guarddog-importer-prisma@0.1.0-alpha.1

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
  - @flowchestra/prisma-guarddog-importer-prisma@0.1.0-alpha.0
