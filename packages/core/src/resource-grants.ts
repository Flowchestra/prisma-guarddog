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
 * resource IDs. `principalClaim` (default 'sub') names the claim that
 * identifies the requesting user; the built-in claims compiler doesn't
 * read it, but it's available to `compileHasGrant` overrides via
 * `ctx.resourceGrants.principalClaim` so an override stays generic over
 * the claim name instead of hardcoding it.
 *
 * **`source: 'table'`** (alpha.2+) — grants live in one or more Postgres
 * tables. Per-resource grant tables (`tables`) and/or a polymorphic
 * catch-all (`fallbackTable`). Each grant table declares:
 *
 *   - a **principal** spec: either a single `principalColumn` /
 *     `principalUserColumn`, or a user-OR-group disjunction
 *     (`principalUserColumn` + `principalGroupColumn` + `groupMemberTable`)
 *     resolved transitively through a membership table (ADR-0023).
 *   - an **action** spec — exactly one of:
 *       - `actionsColumn` (`text[]`)
 *       - `actionColumn` (one row per action)
 *       - `roleColumn` + `roleHierarchy` — rank-based: "user has at least
 *         rank X", compiled to a membership test against the qualifying
 *         suffix of the hierarchy (ADR-0022).
 *
 * See ADR-0021 (table source), ADR-0022 (rank-based), ADR-0023 (principal
 * disjunction).
 */

export type ResourceGrantsSource = 'claims' | 'table'

/**
 * Membership table used to resolve group grants to the requesting user.
 * `userColumn = <principal>` rows yield the groups the user belongs to.
 */
export interface GroupMemberTable {
  readonly name: string
  readonly userColumn: string
  readonly groupColumn: string
}

/**
 * Principal spec shared by per-resource and polymorphic grant tables.
 *
 * Single-principal (today's shape): set `principalColumn` (or its explicit
 * alias `principalUserColumn`).
 *
 * User-OR-group disjunction: set `principalUserColumn` + `principalGroupColumn`
 * + `groupMemberTable`. A grant row matches if its user column equals the
 * principal OR its group column is one of the principal's groups (resolved
 * via `groupMemberTable`).
 */
interface GrantPrincipalSpec {
  /** Legacy/simple spelling of the user column. Alias for `principalUserColumn`. */
  readonly principalColumn?: string
  /** Explicit user-column spelling (preferred when also using groups). */
  readonly principalUserColumn?: string
  /** Group-id column on the grant table. Requires `groupMemberTable`. */
  readonly principalGroupColumn?: string
  /** Membership table for transitive group → user resolution. Requires `principalGroupColumn`. */
  readonly groupMemberTable?: GroupMemberTable
}

/**
 * Action spec shared by per-resource and polymorphic grant tables. Exactly
 * one of the three shapes must be set.
 */
interface GrantActionSpec {
  /** `text[]` column listing granted actions; matched via `<action> = ANY(col)`. */
  readonly actionsColumn?: string
  /** `text` column, one action per row; matched via `col = <action>`. */
  readonly actionColumn?: string
  /**
   * Rank column (e.g. a role enum). With `roleHierarchy`, `hasGrant('EDITOR', ...)`
   * compiles to `col = ANY(ARRAY[<EDITOR and every higher rank>])`.
   */
  readonly roleColumn?: string
  /**
   * Ordered rank vocabulary, lowest → highest. Required with `roleColumn`.
   * Every entry must appear in the top-level `actions` vocabulary.
   */
  readonly roleHierarchy?: ReadonlyArray<string>
  /**
   * Optional Postgres type to cast the rank array literal to (e.g. an enum
   * type name `'"ResourceRole"'`). Inserted verbatim as `::<type>[]`. For
   * integer ranks pass e.g. `'int'` with a numeric-string `roleHierarchy`.
   */
  readonly roleColumnType?: string
}

/**
 * Per-resource grant table config (entry in the `tables` map). Keyed by
 * the scope column name passed to `p.hasGrant(action, col('<scopeColumn>'))`.
 */
export interface PerResourceGrantTable extends GrantPrincipalSpec, GrantActionSpec {
  /** Postgres table name (typically snake_case). */
  readonly name: string
  /**
   * Column holding the resource id (e.g. `workspaceId`). Defaults to the
   * scope-column key the table is registered under (so the common case
   * doesn't need to repeat the column name).
   */
  readonly resourceIdColumn?: string
}

/**
 * Polymorphic catch-all grant table. Used when a `p.hasGrant(...)` call's
 * scope column doesn't have a per-resource override in `tables`. The
 * `scopeColumnTypeMap` is required and tells the compiler which
 * `resourceType` label to emit for each scope column (e.g. `tenantId ->
 * 'Tenant'`).
 */
export interface PolymorphicGrantTable extends GrantPrincipalSpec, GrantActionSpec {
  readonly name: string
  /** e.g. `resourceType`. */
  readonly resourceTypeColumn: string
  /** e.g. `resourceId`. */
  readonly resourceIdColumn: string
  /**
   * Required map: scope column name -> resource type label. The label is
   * what gets written into `<resourceTypeColumn>` in the EXISTS predicate.
   */
  readonly scopeColumnTypeMap: Readonly<Record<string, string>>
}

/**
 * Discriminated by `source`. Both variants carry `principalClaim`
 * (defaulted to 'sub' at construction).
 */
export type ResourceGrantsDefinition<TActions extends string = string> =
  | {
      readonly source: 'claims'
      readonly claimPath: string
      readonly actions: ReadonlyArray<TActions>
      readonly principalClaim: string
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
      readonly principalClaim?: string
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
  const principalClaim = config.principalClaim ?? 'sub'
  if (principalClaim.length === 0) {
    throw new Error(
      '[prisma-guarddog] defineResourceGrants: principalClaim must be a non-empty string (default: "sub").'
    )
  }

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
      principalClaim,
    })
  }

  // source === 'table'
  const tableConfig = config as Extract<DefineResourceGrantsConfig<TActions>, { source: 'table' }>
  const tables = tableConfig.tables ?? {}
  const fallbackTable = tableConfig.fallbackTable
  const actionSet = new Set<string>(config.actions)

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
    const where = `[prisma-guarddog] defineResourceGrants: tables["${scopeColumn}"]`
    if (entry.name.length === 0) {
      throw new Error(`${where}: name must be a non-empty string (the Postgres grant table name).`)
    }
    if (entry.resourceIdColumn !== undefined && entry.resourceIdColumn.length === 0) {
      throw new Error(
        `${where}: resourceIdColumn must be a non-empty string when provided (defaults to "${scopeColumn}").`
      )
    }
    validateGrantPrincipalSpec(where, entry)
    validateGrantActionSpec(where, entry, actionSet)
  }
  if (fallbackTable !== undefined) {
    validatePolymorphicGrantTable(fallbackTable, actionSet)
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

/**
 * Validate the principal spec: exactly one user-column spelling, and the
 * group disjunction is all-or-nothing (`principalGroupColumn` ⇔
 * `groupMemberTable`).
 */
function validateGrantPrincipalSpec(where: string, spec: GrantPrincipalSpec): void {
  const hasLegacy = spec.principalColumn !== undefined && spec.principalColumn.length > 0
  const hasExplicit = spec.principalUserColumn !== undefined && spec.principalUserColumn.length > 0
  if (hasLegacy && hasExplicit) {
    throw new Error(`${where}: set either \`principalColumn\` or \`principalUserColumn\` (they are aliases), not both.`)
  }
  if (!hasLegacy && !hasExplicit) {
    throw new Error(`${where}: a user principal column is required (\`principalColumn\` or \`principalUserColumn\`).`)
  }

  const hasGroupCol = spec.principalGroupColumn !== undefined && spec.principalGroupColumn.length > 0
  const hasGmt = spec.groupMemberTable !== undefined
  if (hasGroupCol !== hasGmt) {
    throw new Error(
      `${where}: \`principalGroupColumn\` and \`groupMemberTable\` must be declared together. ` +
        (hasGroupCol ? 'groupMemberTable is missing.' : 'principalGroupColumn is missing.')
    )
  }
  if (hasGmt) {
    const gmt = spec.groupMemberTable!
    if (gmt.name.length === 0 || gmt.userColumn.length === 0 || gmt.groupColumn.length === 0) {
      throw new Error(`${where}: groupMemberTable.{name,userColumn,groupColumn} must all be non-empty strings.`)
    }
  }
}

/**
 * Validate the action spec: exactly one of actionsColumn / actionColumn /
 * roleColumn. When roleColumn is set, roleHierarchy is required, its entries
 * must be unique + non-empty, and every entry must be a declared action.
 */
function validateGrantActionSpec(where: string, spec: GrantActionSpec, actionSet: ReadonlySet<string>): void {
  const hasActions = spec.actionsColumn !== undefined && spec.actionsColumn.length > 0
  const hasAction = spec.actionColumn !== undefined && spec.actionColumn.length > 0
  const hasRole = spec.roleColumn !== undefined && spec.roleColumn.length > 0
  const count = [hasActions, hasAction, hasRole].filter(Boolean).length
  if (count !== 1) {
    throw new Error(
      `${where}: exactly one of \`actionsColumn\` (text[]), \`actionColumn\` (one row per action), or ` +
        `\`roleColumn\` (rank-based) must be set. ${count} are currently set.`
    )
  }
  if (hasRole) {
    const hierarchy = spec.roleHierarchy
    if (hierarchy === undefined || hierarchy.length === 0) {
      throw new Error(`${where}: \`roleColumn\` requires a non-empty \`roleHierarchy\` (lowest → highest rank).`)
    }
    const seen = new Set<string>()
    for (const rank of hierarchy) {
      if (rank.length === 0) throw new Error(`${where}: roleHierarchy entries must be non-empty strings.`)
      if (seen.has(rank)) throw new Error(`${where}: duplicate rank "${rank}" in roleHierarchy.`)
      seen.add(rank)
      if (!actionSet.has(rank)) {
        throw new Error(
          `${where}: roleHierarchy entry "${rank}" is not in the declared \`actions\` vocabulary. ` +
            'Every rank must be a declared action so `p.hasGrant(rank, col)` type-checks.'
        )
      }
    }
  } else if (spec.roleHierarchy !== undefined || spec.roleColumnType !== undefined) {
    throw new Error(`${where}: \`roleHierarchy\` / \`roleColumnType\` are only valid alongside \`roleColumn\`.`)
  }
}

function validatePolymorphicGrantTable(fallback: PolymorphicGrantTable, actionSet: ReadonlySet<string>): void {
  const where = '[prisma-guarddog] defineResourceGrants: fallbackTable'
  if (fallback.name.length === 0) throw new Error(`${where}: name must be a non-empty string.`)
  if (fallback.resourceTypeColumn.length === 0)
    throw new Error(`${where}: resourceTypeColumn must be a non-empty string.`)
  if (fallback.resourceIdColumn.length === 0) throw new Error(`${where}: resourceIdColumn must be a non-empty string.`)
  validateGrantPrincipalSpec(where, fallback)
  validateGrantActionSpec(where, fallback, actionSet)
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
