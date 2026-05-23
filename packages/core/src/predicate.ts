/**
 * Predicate builder. Used inside `.select(p => ...)`, `.insert({ check: p => ... })`,
 * etc. to author the boolean expression that becomes a Postgres `USING` or
 * `WITH CHECK` clause.
 *
 * Two complementary styles are supported:
 *
 *   Fluent:    `p.claim('tenantId').eq(col('tenantId')).and(p.hasRole(...))`
 *   Functional: `p.and(p.eq(p.claim('tenantId'), col('tenantId')), p.hasRole(...))`
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
   * High-level helper: does the requesting user hold a appRole, optionally
   * scoped to a particular resource identified by a column reference?
   *
   *   p.hasRole('workspace.admin')                          // global
   *   p.hasRole('workspace.admin', col('workspaceId'))      // scoped
   */
  hasRole(role: string, scopeColumn?: FluentExpr): FluentExpr {
    if (role.length === 0) {
      throw new Error('[prisma-guarddog] hasRole: role name must be a non-empty string.')
    }
    let scopeColumnName: string | undefined
    if (scopeColumn !== undefined) {
      if (scopeColumn.ast.kind !== 'col') {
        throw new Error('[prisma-guarddog] hasRole: scopeColumn must be a column reference (use col("name")).')
      }
      scopeColumnName = scopeColumn.ast.column
    }
    return new FluentExpr(Object.freeze({ kind: 'hasRole', role, scopeColumn: scopeColumnName }) as Expr)
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
