/**
 * Predicate builder. Used inside `.select(p => ...)`, `.insert({ check: p => ... })`,
 * etc. to author the boolean expression that becomes a Postgres `USING` or
 * `WITH CHECK` clause.
 *
 * Two complementary styles are supported:
 *
 *   Fluent:    `p.claim('tenantId').eq(col('tenantId')).and(p.hasAppRole(...))`
 *   Functional: `p.and(p.eq(p.claim('tenantId'), col('tenantId')), p.hasAppRole(...))`
 *
 * Both produce identical AST. Pick whichever reads better at the call site.
 *
 * Every method returns a `FluentExpr`. The underlying immutable AST is at
 * `.ast` for emitter consumption.
 */

import type { BinaryOp, Expr, LiteralValue } from './ast.js'

/**
 * Wrapper around an `Expr` that adds fluent combinators. The `ast` is the
 * canonical immutable form the emitter consumes; the methods just construct
 * new wrappers around new ASTs.
 */
export class FluentExpr {
  constructor(public readonly ast: Expr) {
    Object.freeze(this)
  }

  and(other: FluentExpr): FluentExpr {
    return new FluentExpr(
      Object.freeze({
        kind: 'and',
        operands: Object.freeze([this.ast, other.ast]),
      }) as Expr
    )
  }

  or(other: FluentExpr): FluentExpr {
    return new FluentExpr(
      Object.freeze({
        kind: 'or',
        operands: Object.freeze([this.ast, other.ast]),
      }) as Expr
    )
  }

  not(): FluentExpr {
    return new FluentExpr(Object.freeze({ kind: 'not', operand: this.ast }) as Expr)
  }

  eq(other: FluentExpr): FluentExpr {
    return binop('eq', this, other)
  }

  neq(other: FluentExpr): FluentExpr {
    return binop('neq', this, other)
  }

  lt(other: FluentExpr): FluentExpr {
    return binop('lt', this, other)
  }

  lte(other: FluentExpr): FluentExpr {
    return binop('lte', this, other)
  }

  gt(other: FluentExpr): FluentExpr {
    return binop('gt', this, other)
  }

  gte(other: FluentExpr): FluentExpr {
    return binop('gte', this, other)
  }
}

function binop(op: BinaryOp, left: FluentExpr, right: FluentExpr): FluentExpr {
  return new FluentExpr(Object.freeze({ kind: 'binop', op, left: left.ast, right: right.ast }) as Expr)
}

/**
 * Column reference. Top-level helper because `col('x')` reads more clearly
 * than `p.col('x')` at the call site and doesn't need to thread the predicate
 * builder type.
 */
export function col(name: string): FluentExpr {
  if (name.length === 0) {
    throw new Error('[prisma-guarddog] col(): column name must be a non-empty string.')
  }
  return new FluentExpr(Object.freeze({ kind: 'col', column: name }) as Expr)
}

/**
 * Per-policy predicate builder. Parametrized by the registered claims shape
 * so that `p.claim(key)` is type-checked against the actual keys of the
 * configured claims.
 */
export class PredicateBuilder<TClaims = Record<string, unknown>> {
  /**
   * Read a claim. The string key is constrained to the registered claim names.
   *
   *   p.claim('tenantId')  // OK
   *   p.claim('ghost')     // type error
   */
  claim<K extends keyof TClaims & string>(name: K): FluentExpr {
    return new FluentExpr(Object.freeze({ kind: 'claim', path: name }) as Expr)
  }

  /**
   * Literal value. Use for SQL constants — strings, numbers, booleans, null.
   */
  literal(value: LiteralValue): FluentExpr {
    return new FluentExpr(Object.freeze({ kind: 'literal', value }) as Expr)
  }

  // Logical combinators in functional form (also available as fluent on any FluentExpr).

  and(first: FluentExpr, ...rest: FluentExpr[]): FluentExpr {
    return new FluentExpr(
      Object.freeze({
        kind: 'and',
        operands: Object.freeze([first.ast, ...rest.map((e) => e.ast)]),
      }) as Expr
    )
  }

  or(first: FluentExpr, ...rest: FluentExpr[]): FluentExpr {
    return new FluentExpr(
      Object.freeze({
        kind: 'or',
        operands: Object.freeze([first.ast, ...rest.map((e) => e.ast)]),
      }) as Expr
    )
  }

  not(operand: FluentExpr): FluentExpr {
    return new FluentExpr(Object.freeze({ kind: 'not', operand: operand.ast }) as Expr)
  }

  // Binary operators in functional form.

  eq(left: FluentExpr, right: FluentExpr): FluentExpr {
    return binop('eq', left, right)
  }

  neq(left: FluentExpr, right: FluentExpr): FluentExpr {
    return binop('neq', left, right)
  }

  lt(left: FluentExpr, right: FluentExpr): FluentExpr {
    return binop('lt', left, right)
  }

  lte(left: FluentExpr, right: FluentExpr): FluentExpr {
    return binop('lte', left, right)
  }

  gt(left: FluentExpr, right: FluentExpr): FluentExpr {
    return binop('gt', left, right)
  }

  gte(left: FluentExpr, right: FluentExpr): FluentExpr {
    return binop('gte', left, right)
  }

  /**
   * Layer 2 (appRoles): "does the requesting user hold `<role>` globally?"
   *
   *   p.hasAppRole('workspace.admin')
   *
   * Compiles to an inline jsonb containment check against the `roles` claim.
   * Use `hasGrant` for resource-scoped checks instead.
   */
  hasAppRole(role: string): FluentExpr {
    if (role.length === 0) {
      throw new Error('[prisma-guarddog] hasAppRole: role name must be a non-empty string.')
    }
    return new FluentExpr(Object.freeze({ kind: 'hasAppRole', role }) as Expr)
  }

  /**
   * Layer 3 (resourceGrants): "does the requesting user have `<action>` on
   * the resource identified by `<scopeColumn>`?"
   *
   *   p.hasGrant('edit', col('workspaceId'))
   *
   * Compiles to an inline jsonb lookup against the configured resourceGrants
   * claim path (default `grants`). The action vocabulary type-checks against
   * the declared `defineResourceGrants({ actions: [...] })` set when the
   * Guarddog generic is constrained.
   *
   * `opts.table` (table source only) names the `tables`-map key to route to,
   * disambiguating two policies that check the same scope column against
   * different grant tables — e.g. own-row `col('id')` on Workspace vs
   * Workbench. Omit it to route by scope-column name as usual. Ignored for
   * the claims source. See ADR-0025. (alpha.5 will add autocomplete on the
   * key; today it's a validated string — an unknown key throws at compile.)
   */
  hasGrant(action: string, scopeColumn: FluentExpr, opts?: { readonly table?: string }): FluentExpr {
    if (action.length === 0) {
      throw new Error('[prisma-guarddog] hasGrant: action name must be a non-empty string.')
    }
    if (scopeColumn.ast.kind !== 'col') {
      throw new Error('[prisma-guarddog] hasGrant: scopeColumn must be a column reference (use col("name")).')
    }
    if (opts?.table !== undefined && opts.table.length === 0) {
      throw new Error('[prisma-guarddog] hasGrant: opts.table must be a non-empty string when provided.')
    }
    return new FluentExpr(
      Object.freeze({
        kind: 'hasGrant',
        action,
        scopeColumn: scopeColumn.ast.column,
        ...(opts?.table !== undefined && { tableHint: opts.table }),
      }) as Expr
    )
  }

  /**
   * Per-resource jsonb permissions: "does the requesting user have `<action>`
   * in the `permissions` jsonb stored on this row?"
   *
   *   p.hasResourcePermission('read', col('permissions'))
   *
   * Convention: the jsonb column is shaped as
   *   { "users": { "<sub>": ["read", "write"] }, "groups": { ... } }
   * and the default emitter checks the user-keyed entry against the sub
   * claim. Override via `ExprCompileCtx.compileHasResourcePermission` for a
   * different shape (flat grant arrays, group-keyed inclusion, etc.).
   */
  hasResourcePermission(action: string, jsonbColumn: FluentExpr): FluentExpr {
    if (action.length === 0) {
      throw new Error('[prisma-guarddog] hasResourcePermission: action name must be a non-empty string.')
    }
    if (jsonbColumn.ast.kind !== 'col') {
      throw new Error(
        '[prisma-guarddog] hasResourcePermission: jsonbColumn must be a column reference (use col("name")).'
      )
    }
    return new FluentExpr(
      Object.freeze({ kind: 'hasResourcePermission', action, jsonbColumn: jsonbColumn.ast.column }) as Expr
    )
  }

  /**
   * High-level helper: does the requesting user own this row, identified by
   * the value of `ownerColumn` matching the subject claim (`sub`)?
   */
  isOwner(ownerColumn: FluentExpr): FluentExpr {
    if (ownerColumn.ast.kind !== 'col') {
      throw new Error('[prisma-guarddog] isOwner: ownerColumn must be a column reference (use col("name")).')
    }
    return new FluentExpr(Object.freeze({ kind: 'isOwner', ownerColumn: ownerColumn.ast.column }) as Expr)
  }

  /**
   * Membership test. Typical use: column-value `in` claim-array.
   *
   *   p.inArray(col('workspaceId'), p.claim('workspaceIds'))
   */
  inArray(needle: FluentExpr, haystack: FluentExpr): FluentExpr {
    return new FluentExpr(Object.freeze({ kind: 'inArray', needle: needle.ast, haystack: haystack.ast }) as Expr)
  }

  /**
   * Raw SQL escape hatch — content is emitted verbatim into the predicate
   * position. Use sparingly; lose all type-checking and dialect portability.
   * The scaffold importer uses this to wrap legacy hand-written SQL during
   * migration into typed predicates (see ADR-0012).
   */
  raw(sql: string): FluentExpr {
    if (sql.length === 0) {
      throw new Error('[prisma-guarddog] raw: SQL fragment must be a non-empty string.')
    }
    return new FluentExpr(Object.freeze({ kind: 'raw', sql }) as Expr)
  }
}
