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
  ResourceGrantsDefinition,
} from '@prisma-guarddog/core'

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
      const compiler = ctx.compileHasGrant ?? defaultCompileHasGrant
      return compiler(expr.action, scopeColumnRef, ctx)
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
  const claimPath = ctx.resourceGrants?.claimPath ?? 'grants'
  return `((current_setting(${accessorLit}, true)::jsonb -> ${quoteString(claimPath)} -> ${quoteString(action)}) ? (${scopeColumnRef})::text)`
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
