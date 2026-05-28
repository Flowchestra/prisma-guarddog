/**
 * Compile an `Expr` AST to a Postgres SQL fragment. Pure function: no I/O,
 * no global state. Caller supplies the context (current table, claim
 * schema, optional overrides for high-level helpers).
 *
 * Three permission-layer compilers (`hasAppRole`, `hasGrant`,
 * `hasResourcePermission`) and one ownership compiler (`isOwner`) are
 * pluggable via `ExprCompileCtx` because the right SQL shape depends on
 * the consumer's claim structure. Sensible defaults are provided, all
 * fully self-contained (no consumer-side helper functions or schema).
 */

import type {
  BinaryOp,
  ClaimField,
  ClaimsDefinition,
  ClaimsShape,
  Expr,
  PerResourceGrantTable,
  PolymorphicGrantTable,
  ResourceGrantsDefinition,
} from '@flowchestra/prisma-guarddog-core'

import { formatLiteral, quoteIdent, quoteString } from './identifiers.js'

/**
 * Context threaded through every `compileExpr` call.
 */
export interface ExprCompileCtx {
  /**
   * Table name for the policy being compiled. Used for column qualification
   * when `qualifyColumns` is true. Already snake_cased by the caller.
   */
  readonly table: string
  /**
   * When true, `col('x')` compiles to `"table"."x"`. When false, to `"x"`.
   * Polymorphic emission usually wants true so the discriminator equality
   * doesn't ambiguate.
   */
  readonly qualifyColumns: boolean
  readonly claims: ClaimsDefinition
  /**
   * The configured resource-grants layer. Drives the claim path that
   * `hasGrant` compiles against (default 'grants'). Optional — when
   * undefined, `hasGrant` still compiles but uses the convention default.
   */
  readonly resourceGrants?: ResourceGrantsDefinition
  /**
   * Override `p.hasAppRole(role)` compilation. Default checks containment
   * in the `roles` claim via jsonb `?` operator.
   */
  readonly compileHasAppRole?: HasAppRoleCompiler
  /**
   * Override `p.hasGrant(action, col)` compilation. Default reads the
   * configured `resourceGrants.claimPath` (or 'grants') jsonb object,
   * keyed by action name, and checks the row's scope column against the
   * resulting array via `?`.
   */
  readonly compileHasGrant?: HasGrantCompiler
  /**
   * Override `p.hasResourcePermission(action, col)` compilation. Default
   * checks the row's jsonb permissions column under `.users.<sub>` for
   * the action via `?`.
   */
  readonly compileHasResourcePermission?: HasResourcePermissionCompiler
  /**
   * Override the `p.isOwner(col)` compilation. Default compares the
   * column to `(claims ->> 'sub')::uuid`.
   */
  readonly compileIsOwner?: IsOwnerCompiler
}

export type HasAppRoleCompiler = (role: string, ctx: ExprCompileCtx) => string

export type HasGrantCompiler = (action: string, scopeColumnRef: string, ctx: ExprCompileCtx) => string

export type HasResourcePermissionCompiler = (action: string, jsonbColumnRef: string, ctx: ExprCompileCtx) => string

export type IsOwnerCompiler = (ownerColumnRef: string, ctx: ExprCompileCtx) => string

export function compileExpr(expr: Expr, ctx: ExprCompileCtx): string {
  switch (expr.kind) {
    case 'literal':
      return formatLiteral(expr.value)
    case 'col':
      return formatColumnRef(expr.column, ctx)
    case 'claim':
      return compileClaim(expr.path, ctx)
    case 'binop':
      return `(${compileExpr(expr.left, ctx)} ${sqlBinop(expr.op)} ${compileExpr(expr.right, ctx)})`
    case 'and':
      if (expr.operands.length === 0) return 'TRUE'
      if (expr.operands.length === 1) return compileExpr(expr.operands[0] as Expr, ctx)
      return `(${expr.operands.map((o) => compileExpr(o, ctx)).join(' AND ')})`
    case 'or':
      if (expr.operands.length === 0) return 'FALSE'
      if (expr.operands.length === 1) return compileExpr(expr.operands[0] as Expr, ctx)
      return `(${expr.operands.map((o) => compileExpr(o, ctx)).join(' OR ')})`
    case 'not':
      return `(NOT ${compileExpr(expr.operand, ctx)})`
    case 'hasAppRole': {
      const compiler = ctx.compileHasAppRole ?? defaultCompileHasAppRole
      return compiler(expr.role, ctx)
    }
    case 'hasGrant': {
      const scopeColumnRef = formatColumnRef(expr.scopeColumn, ctx)
      // Explicit override always wins. Otherwise dispatch by source: 'table'
      // routes to defaultCompileHasGrantTable (EXISTS against the configured
      // grant table); 'claims' or undefined fall through to the jsonb-claim
      // compiler.
      if (ctx.compileHasGrant !== undefined) {
        return ctx.compileHasGrant(expr.action, scopeColumnRef, ctx)
      }
      if (ctx.resourceGrants?.source === 'table') {
        return defaultCompileHasGrantTable(expr.action, expr.scopeColumn, scopeColumnRef, ctx, expr.tableHint)
      }
      return defaultCompileHasGrant(expr.action, scopeColumnRef, ctx)
    }
    case 'hasResourcePermission': {
      const jsonbColumnRef = formatColumnRef(expr.jsonbColumn, ctx)
      const compiler = ctx.compileHasResourcePermission ?? defaultCompileHasResourcePermission
      return compiler(expr.action, jsonbColumnRef, ctx)
    }
    case 'isOwner': {
      const ownerRef = formatColumnRef(expr.ownerColumn, ctx)
      const compiler = ctx.compileIsOwner ?? defaultCompileIsOwner
      return compiler(ownerRef, ctx)
    }
    case 'inArray':
      return `(${compileExpr(expr.haystack, ctx)} ? (${compileExpr(expr.needle, ctx)})::text)`
    case 'raw':
      // Raw is wrapped in parens to compose safely as a sub-expression.
      return `(${expr.sql})`
  }
}

function formatColumnRef(column: string, ctx: ExprCompileCtx): string {
  return ctx.qualifyColumns ? `${quoteIdent(ctx.table)}.${quoteIdent(column)}` : quoteIdent(column)
}

function compileClaim(path: string, ctx: ExprCompileCtx): string {
  const field = (ctx.claims.shape as ClaimsShape)[path] as ClaimField<unknown> | undefined
  if (field === undefined) {
    throw new Error(
      `[prisma-guarddog/emitter-postgres-rls] compileClaim: unknown claim "${path}". ` +
        `Known claims: ${Object.keys(ctx.claims.shape).join(', ') || '(none)'}`
    )
  }
  const accessorLit = quoteString(ctx.claims.accessor)
  if (field.isArray) {
    // Array claims resolve to a jsonb value that the caller can use with `?`,
    // `@>`, or `jsonb_array_elements`. No cast — the jsonb form is the
    // useful one downstream.
    return `(current_setting(${accessorLit}, true)::jsonb -> ${quoteString(path)})`
  }
  // Scalar: extract as text, then cast per kind.
  const text = `(current_setting(${accessorLit}, true)::json ->> ${quoteString(path)})`
  switch (field.kind) {
    case 'string':
      return text
    case 'uuid':
      return `(${text})::uuid`
    case 'integer':
      return `(${text})::integer`
    case 'boolean':
      return `(${text})::boolean`
  }
}

function sqlBinop(op: BinaryOp): string {
  switch (op) {
    case 'eq':
      return '='
    case 'neq':
      return '<>'
    case 'lt':
      return '<'
    case 'lte':
      return '<='
    case 'gt':
      return '>'
    case 'gte':
      return '>='
  }
}

/**
 * Default `hasAppRole` compilation. Self-contained: checks containment
 * in the `roles` claim via jsonb `?` operator.
 *
 *     ((current_setting('<accessor>', true)::jsonb -> 'roles') ? '<role>')
 *
 * Assumes `roles` is a jsonb array of role strings in the session claims.
 * Consumers with a different claim shape override via
 * `ExprCompileCtx.compileHasAppRole`.
 */
export const defaultCompileHasAppRole: HasAppRoleCompiler = (role, ctx) => {
  const accessorLit = quoteString(ctx.claims.accessor)
  return `((current_setting(${accessorLit}, true)::jsonb -> 'roles') ? ${quoteString(role)})`
}

/**
 * Default `hasGrant` compilation. Self-contained: reads the resourceGrants
 * claim path (default 'grants') as a jsonb object keyed by action name ->
 * jsonb array of resource IDs, and checks whether the row's scope column
 * value appears in that array.
 *
 *     ((current_setting('<accessor>', true)::jsonb -> '<claimPath>' -> '<action>')
 *       ? <scopeColumnRef>::text)
 *
 * If `ctx.resourceGrants` is undefined the path defaults to 'grants'.
 */
export const defaultCompileHasGrant: HasGrantCompiler = (action, scopeColumnRef, ctx) => {
  const accessorLit = quoteString(ctx.claims.accessor)
  const claimPath = ctx.resourceGrants?.source === 'claims' ? ctx.resourceGrants.claimPath : 'grants'
  return `((current_setting(${accessorLit}, true)::jsonb -> ${quoteString(claimPath)} -> ${quoteString(action)}) ? (${scopeColumnRef})::text)`
}

/**
 * Table-backed `hasGrant` compilation. Emits an `EXISTS (SELECT 1 FROM
 * <grant_table> WHERE ...)` predicate scoped to the requesting principal.
 *
 * Dispatch order:
 *   1. `ctx.resourceGrants.tables[scopeColumnName]` — per-resource override
 *   2. `ctx.resourceGrants.fallbackTable` + matching `scopeColumnTypeMap`
 *      entry — polymorphic catch-all
 *   3. Throw — neither path applies (consumer hasn't declared a grant
 *      target for this scope column)
 *
 * Throws at compile time with an actionable message instead of emitting
 * broken SQL — a guarded compile-time failure is far cheaper than a silent
 * "always denies" runtime bug.
 *
 * Principal comparison uses the configured `principalClaim` (default
 * 'sub') cast to uuid — same convention as `defaultCompileIsOwner`.
 * Non-UUID principal columns are not supported by the built-in; consumers
 * with that shape should override via `ExprCompileCtx.compileHasGrant`.
 */
export function defaultCompileHasGrantTable(
  action: string,
  scopeColumnName: string,
  _scopeColumnRef: string,
  ctx: ExprCompileCtx,
  tableHint?: string
): string {
  if (ctx.resourceGrants?.source !== 'table') {
    throw new Error(
      `[prisma-guarddog/emitter-postgres-rls] defaultCompileHasGrantTable invoked but resourceGrants source is "${ctx.resourceGrants?.source ?? 'undefined'}". ` +
        'This is an internal dispatch bug — file an issue.'
    )
  }
  const accessorLit = quoteString(ctx.claims.accessor)
  const principalRef = `(current_setting(${accessorLit}, true)::jsonb ->> ${quoteString(ctx.resourceGrants.principalClaim)})::uuid`

  // Explicit per-call table hint (ADR-0025): route to that `tables` entry
  // regardless of the scope column. The resourceId default comes from the
  // registration key (the hint); the outer ref still uses the actual scope
  // column from the call. Lets two policies check `col('id')` against
  // different grant tables.
  if (tableHint !== undefined) {
    const hinted = ctx.resourceGrants.tables[tableHint]
    if (hinted === undefined) {
      const keys = Object.keys(ctx.resourceGrants.tables)
      throw new Error(
        `[prisma-guarddog/emitter-postgres-rls] hasGrant("${action}", col("${scopeColumnName}"), { table: "${tableHint}" }): ` +
          `no tables["${tableHint}"] entry. Declared keys: [${keys.join(', ')}]. ` +
          'The hint must be a key in defineResourceGrants({ tables }); it does not route to fallbackTable.'
      )
    }
    return emitGrantExists(hinted, action, scopeColumnName, tableHint, ctx.table, principalRef, undefined)
  }

  // Per-resource override wins (registration key === scope column).
  const perResource = ctx.resourceGrants.tables[scopeColumnName]
  if (perResource !== undefined) {
    return emitGrantExists(perResource, action, scopeColumnName, scopeColumnName, ctx.table, principalRef, undefined)
  }

  // Polymorphic fallback.
  const fallback = ctx.resourceGrants.fallbackTable
  if (fallback === undefined) {
    throw new Error(
      `[prisma-guarddog/emitter-postgres-rls] hasGrant("${action}", col("${scopeColumnName}")): no per-resource entry in tables{} and no fallbackTable configured. ` +
        `Add a tables["${scopeColumnName}"] entry, pass { table } to route explicitly, or declare a fallbackTable in defineResourceGrants.`
    )
  }
  const resourceTypeLabel = fallback.scopeColumnTypeMap[scopeColumnName]
  if (resourceTypeLabel === undefined) {
    throw new Error(
      `[prisma-guarddog/emitter-postgres-rls] hasGrant("${action}", col("${scopeColumnName}")): no per-resource entry in tables{} and fallbackTable.scopeColumnTypeMap has no entry for "${scopeColumnName}". ` +
        `Add scopeColumnTypeMap["${scopeColumnName}"] = "<ResourceTypeLabel>" or add a tables["${scopeColumnName}"] entry.`
    )
  }
  return emitGrantExists(fallback, action, scopeColumnName, scopeColumnName, ctx.table, principalRef, resourceTypeLabel)
}

/**
 * Shared EXISTS-emit for both per-resource and polymorphic paths. The
 * `resourceTypeLabel` parameter is undefined for per-resource (no
 * discriminator equality) and a literal string for polymorphic.
 *
 * `registrationKey` is the `tables`-map key the entry is registered under
 * (used only as the default for `resourceIdColumn`). `outerScopeColumnName`
 * is the column from the `hasGrant` call (the outer-row side). These differ
 * only when a per-call table hint routes a `col('id')` check to a table
 * registered under a different key — then the resourceId default comes from
 * the key but the correlation column is the call's `col('id')`.
 *
 * Column qualification is critical: the grant table and the outer policy's
 * table commonly share a column name. Without explicit qualification, an
 * unquoted `workspaceId = workspaceId` inside the EXISTS subquery binds BOTH
 * sides to the inner table, degenerating to "any grant row exists for the
 * user" and losing the outer-row correlation. We fully qualify both sides —
 * grant-table columns with the grant table name; the outer scope reference
 * with the policy's `ctx.table`.
 */
function emitGrantExists(
  table: PerResourceGrantTable | PolymorphicGrantTable,
  action: string,
  outerScopeColumnName: string,
  registrationKey: string,
  outerTableName: string,
  principalRef: string,
  resourceTypeLabel: string | undefined
): string {
  const tableIdent = quoteIdent(table.name)

  // Per-resource: resourceIdColumn defaults to the registration key (the
  // tables-map key). Polymorphic: it's always explicit on the type.
  const resourceIdColName =
    (table as PolymorphicGrantTable).resourceIdColumn ??
    (table as PerResourceGrantTable).resourceIdColumn ??
    registrationKey
  const resourceIdCol = `${tableIdent}.${quoteIdent(resourceIdColName)}`

  // Outer-scope ref MUST be qualified with the policy's table to avoid
  // colliding with the grant table's same-named column inside the subquery.
  const outerRef = `${quoteIdent(outerTableName)}.${quoteIdent(outerScopeColumnName)}`

  const clauses: string[] = [emitPrincipalClause(table, tableIdent, principalRef), `${resourceIdCol} = ${outerRef}`]

  if (resourceTypeLabel !== undefined) {
    const typeCol = `${tableIdent}.${quoteIdent((table as PolymorphicGrantTable).resourceTypeColumn)}`
    clauses.push(`${typeCol} = ${quoteString(resourceTypeLabel)}`)
  }

  clauses.push(emitActionClause(table, action, tableIdent))

  return `EXISTS (SELECT 1 FROM ${tableIdent} WHERE ${clauses.join(' AND ')})`
}

/**
 * Principal clause. Single-column form: `<table>.<userCol> = <principal>`.
 * User-OR-group disjunction (ADR-0023): the user column matches OR the
 * group column is one of the principal's groups, resolved transitively
 * through the membership table.
 *
 * Group-membership columns are qualified with the membership table name so
 * the nested sub-select can't ambiguate against the grant table.
 */
function emitPrincipalClause(
  table: PerResourceGrantTable | PolymorphicGrantTable,
  tableIdent: string,
  principalRef: string
): string {
  const userColName = table.principalUserColumn ?? table.principalColumn
  // Validation guarantees one of these is set.
  const userCol = `${tableIdent}.${quoteIdent(userColName!)}`
  const userMatch = `${userCol} = ${principalRef}`

  if (table.principalGroupColumn === undefined || table.groupMemberTable === undefined) {
    return userMatch
  }

  const groupCol = `${tableIdent}.${quoteIdent(table.principalGroupColumn)}`
  const gmt = table.groupMemberTable
  const gmtIdent = quoteIdent(gmt.name)
  const gmtGroupCol = `${gmtIdent}.${quoteIdent(gmt.groupColumn)}`
  const gmtUserCol = `${gmtIdent}.${quoteIdent(gmt.userColumn)}`
  const groupMatch = `${groupCol} IN (SELECT ${gmtGroupCol} FROM ${gmtIdent} WHERE ${gmtUserCol} = ${principalRef})`

  return `(${userMatch} OR ${groupMatch})`
}

/**
 * Action clause. Three shapes (validation guarantees exactly one):
 *   - actionsColumn (text[]):  `'<action>' = ANY(<table>.<col>)`
 *   - actionColumn:            `<table>.<col> = '<action>'`
 *   - roleColumn + hierarchy:  `<table>.<col> = ANY(ARRAY[<rank..highest>]::<type>[])`
 *     where the array is the suffix of the hierarchy from the requested
 *     rank upward (rank-based "at least" semantics, ADR-0022).
 */
function emitActionClause(
  table: PerResourceGrantTable | PolymorphicGrantTable,
  action: string,
  tableIdent: string
): string {
  if (table.actionsColumn !== undefined && table.actionsColumn.length > 0) {
    return `${quoteString(action)} = ANY(${tableIdent}.${quoteIdent(table.actionsColumn)})`
  }
  if (table.actionColumn !== undefined && table.actionColumn.length > 0) {
    return `${tableIdent}.${quoteIdent(table.actionColumn)} = ${quoteString(action)}`
  }
  // roleColumn + roleHierarchy — validation guarantees both are set here.
  const roleCol = `${tableIdent}.${quoteIdent(table.roleColumn!)}`
  const hierarchy = table.roleHierarchy!
  const idx = hierarchy.indexOf(action)
  if (idx === -1) {
    throw new Error(
      `[prisma-guarddog/emitter-postgres-rls] hasGrant("${action}", ...): rank "${action}" is not in ` +
        `roleHierarchy [${hierarchy.join(', ')}] for grant table "${table.name}". ` +
        'The requested rank must be one of the declared hierarchy ranks.'
    )
  }
  const qualifying = hierarchy.slice(idx) // requested rank and everything higher
  const cast =
    table.roleColumnType !== undefined && table.roleColumnType.length > 0 ? `::${table.roleColumnType}[]` : ''
  const arrayLit = `ARRAY[${qualifying.map((r) => quoteString(r)).join(', ')}]${cast}`
  return `${roleCol} = ANY(${arrayLit})`
}

/**
 * Default `hasResourcePermission` compilation. Self-contained: checks the
 * row's jsonb permissions column under `.users.<sub>` for the action.
 *
 *     ((<jsonbColumnRef> -> 'users' -> (claims ->> 'sub')) ? '<action>')
 *
 * Convention: the jsonb column is shaped as
 *   { "users": { "<sub>": ["read", "write"] }, "groups": { ... } }
 *
 * Override via `ExprCompileCtx.compileHasResourcePermission` for different
 * shapes (e.g., group-keyed inclusion, flat grant arrays).
 */
export const defaultCompileHasResourcePermission: HasResourcePermissionCompiler = (action, jsonbColumnRef, ctx) => {
  const accessorLit = quoteString(ctx.claims.accessor)
  const subClaim = `(current_setting(${accessorLit}, true)::json ->> 'sub')`
  return `((${jsonbColumnRef} -> 'users' -> ${subClaim}) ? ${quoteString(action)})`
}

/**
 * Default `isOwner` compilation strategy: column equals the subject claim,
 * cast to UUID. Override via `ExprCompileCtx.compileIsOwner` if the
 * subject claim is not a UUID (e.g., integer user IDs) or if a different
 * claim name carries the owner reference.
 */
export const defaultCompileIsOwner: IsOwnerCompiler = (ownerColumnRef, ctx) => {
  const accessorLit = quoteString(ctx.claims.accessor)
  const subClaim = `(current_setting(${accessorLit}, true)::json ->> 'sub')`
  return `(${ownerColumnRef} = ${subClaim}::uuid)`
}
