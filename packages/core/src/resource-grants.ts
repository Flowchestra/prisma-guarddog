/**
 * `defineResourceGrants` — declare the resource-grant layer (layer 3 of the
 * three permission layers). A resource grant is a principal × action ×
 * resource record. Authoring this primitive lets policy predicates check
 * "does the user have permission to do `<action>` on `<resource>`?" via
 * `p.hasGrant(action, col(...))`.
 *
 * The `actions` vocabulary is declared here so `hasGrant('edit', col(...))`
 * type-checks at the call site against the declared set — same idea as
 * `defineAppRoles` for role strings.
 *
 * Two sources are supported:
 *
 * **`source: 'claims'`** (Phase 1, the original) — grants are encoded in
 * the session claims as a jsonb object keyed by action name -> array of
 * resource IDs:
 *
 *     // claims payload
 *     {
 *       "grants": {
 *         "edit":   ["ws-1", "ws-2"],
 *         "delete": ["ws-1"],
 *         "admin":  ["ws-1"]
 *       }
 *     }
 *
 * **`source: 'table'`** (alpha.2+) — grants live in one or more Postgres
 * tables. Most consumers maintain dedicated per-resource grant tables (e.g.
 * `workspace_grant`, `workbench_grant`) AND/OR a polymorphic catch-all
 * (`resource_grant` with a `resourceType` discriminator). Both shapes can
 * be declared together — per-resource overrides win for the columns they
 * cover, polymorphic fallback handles the rest. See ADR-0021 for the
 * design.
 *
 *     defineResourceGrants({
 *       source: 'table',
 *       actions: ['edit', 'admin'],
 *       tables: {
 *         workspaceId: {
 *           name: 'workspace_grant',
 *           principalColumn: 'userId',
 *           actionsColumn: 'actions',
 *           // resourceIdColumn defaults to the key ('workspaceId')
 *         },
 *       },
 *       fallbackTable: {
 *         name: 'resource_grant',
 *         principalColumn: 'userId',
 *         resourceTypeColumn: 'resourceType',
 *         resourceIdColumn: 'resourceId',
 *         actionsColumn: 'actions',
 *         scopeColumnTypeMap: { tenantId: 'Tenant', orgId: 'Org' },
 *       },
 *     })
 */

export type ResourceGrantsSource = 'claims' | 'table'

/**
 * Per-resource grant table config (entry in the `tables` map). Keyed by
 * the scope column name passed to `p.hasGrant(action, col('<scopeColumn>'))`.
 * Exactly one of `actionColumn` / `actionsColumn` must be set — the former
 * for one-row-per-action storage, the latter for `text[]` storage.
 */
export interface PerResourceGrantTable {
  /** Postgres table name (typically snake_case). */
  readonly name: string
  /** Column holding the principal id (e.g. `userId`). Compared to the claim. */
  readonly principalColumn: string
  /**
   * Column holding the resource id (e.g. `workspaceId`). Defaults to the
   * scope-column key the table is registered under (so the common case
   * doesn't need to repeat the column name).
   */
  readonly resourceIdColumn?: string
  /** `text[]` column listing granted actions. Mutually exclusive with `actionColumn`. */
  readonly actionsColumn?: string
  /** `text` column holding one action per row. Mutually exclusive with `actionsColumn`. */
  readonly actionColumn?: string
}

/**
 * Polymorphic catch-all grant table. Used when a `p.hasGrant(...)` call's
 * scope column doesn't have a per-resource override in `tables`. The
 * `scopeColumnTypeMap` is required and tells the compiler which
 * `resourceType` label to emit for each scope column (e.g. `tenantId ->
 * 'Tenant'`).
 */
export interface PolymorphicGrantTable {
  readonly name: string
  readonly principalColumn: string
  /** e.g. `resourceType`. */
  readonly resourceTypeColumn: string
  /** e.g. `resourceId`. */
  readonly resourceIdColumn: string
  /** Same mutual exclusion as `PerResourceGrantTable`. */
  readonly actionsColumn?: string
  readonly actionColumn?: string
  /**
   * Required map: scope column name -> resource type label. The label is
   * what gets written into `<resourceTypeColumn>` in the EXISTS predicate.
   */
  readonly scopeColumnTypeMap: Readonly<Record<string, string>>
}

/**
 * Discriminated by `source`. Existing claim-based consumers keep the same
 * shape; table-based consumers carry the new table config.
 */
export type ResourceGrantsDefinition<TActions extends string = string> =
  | {
      readonly source: 'claims'
      readonly claimPath: string
      readonly actions: ReadonlyArray<TActions>
    }
  | {
      readonly source: 'table'
      readonly actions: ReadonlyArray<TActions>
      readonly tables: Readonly<Record<string, PerResourceGrantTable>>
      readonly fallbackTable: PolymorphicGrantTable | undefined
      readonly principalClaim: string
    }

type DefineResourceGrantsConfig<TActions extends string> =
  | {
      readonly source?: 'claims'
      readonly claimPath?: string
      readonly actions: ReadonlyArray<TActions>
    }
  | {
      readonly source: 'table'
      readonly actions: ReadonlyArray<TActions>
      readonly tables?: Readonly<Record<string, PerResourceGrantTable>>
      readonly fallbackTable?: PolymorphicGrantTable
      readonly principalClaim?: string
    }

export function defineResourceGrants<const TActions extends string>(
  config: DefineResourceGrantsConfig<TActions>
): ResourceGrantsDefinition<TActions> {
  validateActions(config.actions)

  const source: ResourceGrantsSource = config.source ?? 'claims'

  if (source === 'claims') {
    const claimPath = (config as { claimPath?: string }).claimPath ?? 'grants'
    if (claimPath.length === 0) {
      throw new Error(
        '[prisma-guarddog] defineResourceGrants: claimPath must be a non-empty string (default: "grants").'
      )
    }
    return Object.freeze({
      source: 'claims' as const,
      claimPath,
      actions: Object.freeze([...config.actions]) as ReadonlyArray<TActions>,
    })
  }

  // source === 'table'
  const tableConfig = config as Extract<DefineResourceGrantsConfig<TActions>, { source: 'table' }>
  const tables = tableConfig.tables ?? {}
  const fallbackTable = tableConfig.fallbackTable

  const tableEntries = Object.entries(tables)
  if (tableEntries.length === 0 && fallbackTable === undefined) {
    throw new Error(
      "[prisma-guarddog] defineResourceGrants({ source: 'table' }): must declare at least one of `tables` (per-resource) or `fallbackTable` (polymorphic). " +
        'Otherwise `p.hasGrant(...)` calls have no SQL target to compile against.'
    )
  }
  for (const [scopeColumn, entry] of tableEntries) {
    if (scopeColumn.length === 0) {
      throw new Error(
        '[prisma-guarddog] defineResourceGrants: tables{} keys (scope column names) must be non-empty strings.'
      )
    }
    validatePerResourceGrantTable(scopeColumn, entry)
  }
  if (fallbackTable !== undefined) {
    validatePolymorphicGrantTable(fallbackTable)
  }

  const principalClaim = tableConfig.principalClaim ?? 'sub'
  if (principalClaim.length === 0) {
    throw new Error(
      '[prisma-guarddog] defineResourceGrants: principalClaim must be a non-empty string (default: "sub").'
    )
  }

  return Object.freeze({
    source: 'table' as const,
    actions: Object.freeze([...config.actions]) as ReadonlyArray<TActions>,
    tables: Object.freeze({ ...tables }),
    fallbackTable: fallbackTable === undefined ? undefined : Object.freeze({ ...fallbackTable }),
    principalClaim,
  })
}

function validateActions(actions: ReadonlyArray<string>): void {
  if (actions.length === 0) {
    throw new Error(
      '[prisma-guarddog] defineResourceGrants: actions must be a non-empty array. ' +
        "The action vocabulary is what enables type-checked p.hasGrant('action', col) calls."
    )
  }
  const seen = new Set<string>()
  for (const action of actions) {
    if (action.length === 0) {
      throw new Error('[prisma-guarddog] defineResourceGrants: action names must be non-empty strings.')
    }
    if (seen.has(action)) {
      throw new Error(
        `[prisma-guarddog] defineResourceGrants: duplicate action "${action}" in actions[]. Each action must be unique.`
      )
    }
    seen.add(action)
  }
}

function validatePerResourceGrantTable(scopeColumn: string, entry: PerResourceGrantTable): void {
  const where = `[prisma-guarddog] defineResourceGrants: tables["${scopeColumn}"]`
  if (entry.name.length === 0) {
    throw new Error(`${where}: name must be a non-empty string (the Postgres grant table name).`)
  }
  if (entry.principalColumn.length === 0) {
    throw new Error(`${where}: principalColumn must be a non-empty string.`)
  }
  const hasActions = entry.actionsColumn !== undefined && entry.actionsColumn.length > 0
  const hasAction = entry.actionColumn !== undefined && entry.actionColumn.length > 0
  if (hasActions === hasAction) {
    throw new Error(
      `${where}: exactly one of \`actionColumn\` (one row per action) or \`actionsColumn\` (text[] array) must be set. ` +
        (hasActions ? 'Both are currently set.' : 'Neither is set.')
    )
  }
  if (entry.resourceIdColumn !== undefined && entry.resourceIdColumn.length === 0) {
    throw new Error(
      `${where}: resourceIdColumn must be a non-empty string when provided (defaults to "${scopeColumn}").`
    )
  }
}

function validatePolymorphicGrantTable(fallback: PolymorphicGrantTable): void {
  const where = '[prisma-guarddog] defineResourceGrants: fallbackTable'
  if (fallback.name.length === 0) throw new Error(`${where}: name must be a non-empty string.`)
  if (fallback.principalColumn.length === 0) throw new Error(`${where}: principalColumn must be a non-empty string.`)
  if (fallback.resourceTypeColumn.length === 0)
    throw new Error(`${where}: resourceTypeColumn must be a non-empty string.`)
  if (fallback.resourceIdColumn.length === 0) throw new Error(`${where}: resourceIdColumn must be a non-empty string.`)
  const hasActions = fallback.actionsColumn !== undefined && fallback.actionsColumn.length > 0
  const hasAction = fallback.actionColumn !== undefined && fallback.actionColumn.length > 0
  if (hasActions === hasAction) {
    throw new Error(
      `${where}: exactly one of \`actionColumn\` or \`actionsColumn\` must be set. ` +
        (hasActions ? 'Both are currently set.' : 'Neither is set.')
    )
  }
  const mapEntries = Object.entries(fallback.scopeColumnTypeMap ?? {})
  if (mapEntries.length === 0) {
    throw new Error(
      `${where}: scopeColumnTypeMap must declare at least one scope-column → resource-type-label entry. ` +
        'Without it, the polymorphic compiler cannot resolve which `resourceType` value to write for a given `p.hasGrant(action, col(...))` call.'
    )
  }
  for (const [scopeColumn, label] of mapEntries) {
    if (scopeColumn.length === 0 || label.length === 0) {
      throw new Error(`${where}: scopeColumnTypeMap entries must have non-empty keys and values.`)
    }
  }
}
