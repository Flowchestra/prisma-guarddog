# @flowchestra/prisma-guarddog-emitter-postgres-rls

## 0.1.0-alpha.15

### Minor Changes

- [`b4dc062`](https://github.com/Flowchestra/prisma-guarddog/commit/b4dc06288f988657dbeb99e21a8185ab9398a26c)
  Thanks [@Henry-Steele](https://github.com/Henry-Steele)! - Add **per-command
  restrictive policies** for issue #30 (ADR-0034). `RestrictivePolicyBuilder`
  gains `.forSelect / .forInsert / .forUpdate / .forDelete` alongside the
  existing `.forAll`, so a restrictive predicate can target only specific
  commands instead of all four. The canonical archetype is a SELECT-only
  soft-delete restrictive that filters reads against `deleted_at IS NULL`
  without coupling that floor to write operations.

  ```ts
  guard.model('Workspace').table('workspaces')
    // Uniform tenant floor — every command.
    .isolation('boundary', (p) => p.claim('tenantId').eq(col('tenant_id')))
    // SELECT-only soft-delete restrictive — emits as `AS RESTRICTIVE FOR SELECT`.
    .restrictivePolicy('public', 'no_soft_deleted')
      .forSelect((p) => p.raw('deleted_at IS NULL'))
    // INSERT-only restrictive — blocks creating pre-soft-deleted rows.
    .restrictivePolicy('public', 'no_pre_deleted')
      .forInsert({ check: (p) => p.raw('deleted_at IS NULL') })
    // Permissive access — the floors are already AND'd in.
    .policy('app_user')
      .select((p) => /* visibility OR FGAC */)
  ```

  API shape mirrors the existing permissive `PolicyBuilder` verb methods
  exactly:
  - `.forSelect(fn, opts?)` — USING-only, FOR SELECT
  - `.forInsert({ check, name? })` — WITH CHECK only, FOR INSERT (no USING per
    [ADR-0005](../docs/adr/0005-explicit-using-and-with-check.md))
  - `.forUpdate({ using, check, name? })` — both, FOR UPDATE
  - `.forDelete({ using, name? })` — USING-only, FOR DELETE
  - `.forAll(fn, opts?)` — preserved; uniform predicate for all commands

  **Mutex guard.** A single `RestrictivePolicyBuilder` holds either `.forAll` or
  any subset of per-verb specs — never both. Mixing them on the same builder
  throws at the second call with a clear error message ("catalog-distinct in
  Postgres; use distinct slots to express both shapes"). To author both shapes
  on the same `(model, dbRole)`, declare them under distinct slots
  ([ADR-0033](../docs/adr/0033-named-slots-for-restrictive-policies.md)).

  **Auto-name resolution.** Per-verb specs follow the existing convention:

  | Form                                                  | Auto-name                      |
  | ----------------------------------------------------- | ------------------------------ |
  | `.forSelect(fn)` (default slot)                       | `<table>_<role>_select`        |
  | `.forSelect(fn)` (with slot)                          | `<table>_<role>_<slot>_select` |
  | Same shape for `.forInsert / .forUpdate / .forDelete` | (verb in the suffix)           |

  `.named(name)` / per-call `{ name }` overrides continue to win over the
  auto-name.

  **Note on Postgres semantics.** SELECT policies — permissive _and_ restrictive
  — also gate row-visibility for UPDATE / DELETE row-finding. That's a Postgres
  behavior, not a guarddog one. A `forSelect` restrictive that hides
  soft-deleted rows will therefore also prevent `UPDATE WHERE id = X` from
  finding those rows by their ID. For undelete-style flows in practice, use a
  BYPASSRLS role (`app_system`) or place the operation behind a SECURITY DEFINER
  function ([ADR-0026](../docs/adr/0026-managed-sql-functions.md)).
  - **core**: `RestrictivePolicyBuilder` gains
    `_select / _insert / _update / _delete` internal fields and the four
    per-verb methods; `_toAst()` returns them on the `PolicyAst` (alongside the
    existing `all` for `.forAll`). The mutex guard runs on every call. No new
    AST shapes — the per-verb specs reuse
    `SelectSpec / InsertSpec / UpdateSpec / DeleteSpec`.
  - **lifecycle**: `appendPolicyOps` already iterated per-verb specs; threads
    `pol.restrictive` and `pol.slot` through the per-verb branches (previously
    hardcoded `false / undefined`). The name-resolution rule extends to handle
    the slot+verb combination as `<table>_<role>_<slot>_<verb>`.
  - **emitter-postgres-rls**: per-verb name resolution honors the slot;
    restrictive emission unchanged at the SQL-shape level (the existing
    `AS RESTRICTIVE` clause was already threaded through every verb branch in
    alpha.14).
  - **drift**: no new code — `restrictivenessMismatch`
    ([ADR-0032](../docs/adr/0032-restrictive-policy-support.md)) already catches
    per-verb permissive ↔ restrictive flips by virtue of being keyed on
    `(table, name)` regardless of the verb.

  Pairs with
  [ADR-0033](../docs/adr/0033-named-slots-for-restrictive-policies.md) — the
  canonical multi-invariant shape is now `.isolation('boundary', fn)` (uniform
  tenant floor) +
  `.restrictivePolicy('public', 'no_soft_deleted').forSelect(...)` (SELECT-only
  read floor) on the same model.

- [`8032b2c`](https://github.com/Flowchestra/prisma-guarddog/commit/8032b2c87c88826f0a8666f57e653c57fe7fcb66)
  Thanks [@Henry-Steele](https://github.com/Henry-Steele)! - Add **named slots
  for restrictive policies** for issue #29 (ADR-0033). Multiple restrictive
  invariants can now coexist on the same `(model, dbRole)` — e.g., a boundary
  slot AND a no-soft-deleted slot — authored as **distinct
  `.isolation(slot, fn)` calls** rather than one AND-combined predicate. Each
  slot maps to its own `pg_policies` row with a meaningful name.

  ```ts
  guard.model('Workspace').table('workspaces')
    // Two distinct invariants → two restrictive pg_policies rows.
    .isolation('boundary', (p) =>
      p.fn('current_tenant_id').eq(col('tenant_id')).and(
        p.or(
          col('org_id').eq(p.fn('current_org_id')),
          p.fn('org_has_cross_org_access', col('org_id'), p.fn('current_org_id'), 'WORKSPACE', col('id'), null),
        )
      )
    )
    .isolation('no_soft_deleted', (p) => p.raw('deleted_at IS NULL'))
    .policy('app_user').select((p) => /* access only — both floors AND'd */)

  // Low-level slot form — same key shape.
  guard.model('Widget').restrictivePolicy('public', 'boundary').forAll((p) => …)
  guard.model('Widget').restrictivePolicy('public', 'no_soft_deleted').forAll((p) => …)
  ```

  Backward compatible — alpha.14 calls without a slot hit the default slot
  (`'default'`) and resolve to the existing `<table>_isolation` /
  `<table>_<role>_all` auto-names unchanged.

  **Auto-name resolution** (when no `.named(...)` override is set):

  | Form                                                 | Auto-name                                   |
  | ---------------------------------------------------- | ------------------------------------------- |
  | `.isolation(fn)` (default slot)                      | `<table>_isolation` _(alpha.14 preserved)_  |
  | `.isolation('boundary', fn)`                         | `<table>_boundary`                          |
  | `.restrictivePolicy(role).forAll(fn)` (default slot) | `<table>_<role>_all` _(alpha.14 preserved)_ |
  | `.restrictivePolicy(role, 'boundary').forAll(fn)`    | `<table>_<role>_boundary`                   |
  - **core**: `PolicyAst` gains `slot?: string`. `RestrictivePolicyBuilder`
    constructor takes the slot and surfaces it via the readonly `slot` field.
    `ModelBuilder.restrictivePolicy(role, slot?)` and overloaded
    `ModelBuilder.isolation(slot?, fn, opts?)` accept an optional slot string.
    Registry re-keys from `(model, dbRole)` to `(model, dbRole, slot)`; same
    slot returns the same builder, different slots are independent. Lifecycle
    threads `slot` into `makeCreatePolicyOp` for slot-aware auto-naming. The
    existing compile-time duplicate-name guard
    ([ADR-0031](../docs/adr/0031-user-declared-policy-names.md)) catches
    collisions when two slots resolve to the same name.
  - **emitter-postgres-rls**: AST emitter (`emitPolicy`) honors slot in the same
    name-resolution rules as the lifecycle.
  - **lint**: slots are structural (no nudge). The existing
    `policy-uses-declared-name` warning still fires only on `.named()` /
    per-verb `{ name }`.

  Pairs with the upcoming ADR-0034 (per-command restrictive policies) — once a
  restrictive can be `FOR SELECT`-only, the slot is the registry handle that
  lets distinct invariants target different command sets.

### Patch Changes

- Updated dependencies
  [[`b4dc062`](https://github.com/Flowchestra/prisma-guarddog/commit/b4dc06288f988657dbeb99e21a8185ab9398a26c),
  [`8032b2c`](https://github.com/Flowchestra/prisma-guarddog/commit/8032b2c87c88826f0a8666f57e653c57fe7fcb66)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.15

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

## 0.1.0-alpha.12

### Patch Changes

- Updated dependencies []:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.12

## 0.1.0-alpha.11

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

## 0.1.0-alpha.5

### Patch Changes

- Updated dependencies
  [[`753e022`](https://github.com/Flowchestra/prisma-guarddog/commit/753e0222b9aa4f4f2866b03965f7cb3c61d95718)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.5

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

### Patch Changes

- Updated dependencies
  [[`79fe642`](https://github.com/Flowchestra/prisma-guarddog/commit/79fe642f0d1d1f2bb0cdf470d7f944618245aa33)]:
  - @flowchestra/prisma-guarddog-core@0.1.0-alpha.4

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
