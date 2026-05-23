/**
 * Compile an `Expr` AST to a Postgres SQL fragment. Pure function: no I/O,
 * no global state. Caller supplies the context (current table, claim
 * schema, optional overrides for high-level helpers).
 *
 * The `hasRole` and `isOwner` strategies are pluggable via `ExprCompileCtx`
 * because the right SQL shape depends on the consumer's claim structure
 * and grant-table conventions. Sensible defaults are provided.
 */

import type { BinaryOp, ClaimField, ClaimsDefinition, ClaimsShape, Expr } from '@prisma-guarddog/core'

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
   * Override the `p.hasRole(role, scopeColumn?)` compilation. Default
   * checks containment in the `roles` claim (jsonb `?`) for scope-less
   * calls, and calls a helper function `app.has_role_on(role, scopeId)`
   * for scoped calls — consumers can implement that helper against their
   * own grants table or override entirely.
   */
  readonly compileHasRole?: HasRoleCompiler
  /**
   * Override the `p.isOwner(col)` compilation. Default compares the
   * column to `(claims ->> 'sub')::uuid`.
   */
  readonly compileIsOwner?: IsOwnerCompiler
}

export type HasRoleCompiler = (role: string, scopeColumnRef: string | undefined, ctx: ExprCompileCtx) => string

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
    case 'hasRole': {
      const scopeColumnRef = expr.scopeColumn === undefined ? undefined : formatColumnRef(expr.scopeColumn, ctx)
      const compiler = ctx.compileHasRole ?? defaultCompileHasRole
      return compiler(expr.role, scopeColumnRef, ctx)
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
 * Default `hasRole` compilation strategy:
 *
 *   scope-less:  (current_setting('jwt.claims', true)::jsonb -> 'roles') ? '<role>'
 *   scoped:      app.has_role_on('<role>', <scopeCol>::uuid)
 *
 * The scope-less form assumes `roles` is a jsonb array of strings in claims.
 * The scoped form delegates to a Postgres helper function the consumer
 * implements — guarddog does not assume a grants-table shape. Override
 * via `ExprCompileCtx.compileHasRole` for project-specific shapes (e.g.,
 * an FGA service or a different claim structure).
 */
export const defaultCompileHasRole: HasRoleCompiler = (role, scopeColumnRef, ctx) => {
  const accessorLit = quoteString(ctx.claims.accessor)
  const rolesArray = `(current_setting(${accessorLit}, true)::jsonb -> 'roles')`
  const roleCheck = `(${rolesArray} ? ${quoteString(role)})`
  if (scopeColumnRef === undefined) return roleCheck
  return `app.has_role_on(${quoteString(role)}, ${scopeColumnRef}::uuid)`
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
