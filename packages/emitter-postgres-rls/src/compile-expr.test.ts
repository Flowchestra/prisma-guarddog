import { defineClaims } from '@prisma-guarddog/core'
import type { ClaimsDefinition, Expr, LiteralValue } from '@prisma-guarddog/core'
import { describe, expect, it } from 'vitest'

import { compileExpr, defaultCompileHasRole, defaultCompileIsOwner, type ExprCompileCtx } from './compile-expr.js'

const claims: ClaimsDefinition = defineClaims({
  accessor: 'request.jwt.claims',
  shape: (c) => ({
    sub: c.uuid(),
    tenantId: c.uuid(),
    workspaceIds: c.array(c.uuid()),
    roles: c.array(c.string()),
    age: c.integer(),
    active: c.boolean(),
  }),
})

const baseCtx = (overrides: Partial<ExprCompileCtx> = {}): ExprCompileCtx => ({
  table: 'workbench',
  qualifyColumns: false,
  claims,
  ...overrides,
})

const literal = (value: LiteralValue): Expr => Object.freeze({ kind: 'literal', value }) as Expr
const col = (column: string): Expr => Object.freeze({ kind: 'col', column }) as Expr
const claim = (path: string): Expr => Object.freeze({ kind: 'claim', path }) as Expr
const and = (...operands: Expr[]): Expr => Object.freeze({ kind: 'and', operands: Object.freeze(operands) }) as Expr
const or = (...operands: Expr[]): Expr => Object.freeze({ kind: 'or', operands: Object.freeze(operands) }) as Expr
const not = (operand: Expr): Expr => Object.freeze({ kind: 'not', operand }) as Expr
const binop = (op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte', left: Expr, right: Expr): Expr =>
  Object.freeze({ kind: 'binop', op, left, right }) as Expr
const hasRole = (role: string, scopeColumn?: string): Expr =>
  Object.freeze({ kind: 'hasRole', role, scopeColumn }) as Expr
const isOwner = (ownerColumn: string): Expr => Object.freeze({ kind: 'isOwner', ownerColumn }) as Expr
const inArray = (needle: Expr, haystack: Expr): Expr => Object.freeze({ kind: 'inArray', needle, haystack }) as Expr
const raw = (sql: string): Expr => Object.freeze({ kind: 'raw', sql }) as Expr

describe('compileExpr — leaves', () => {
  it('compiles literals', () => {
    const ctx = baseCtx()
    expect(compileExpr(literal('hi'), ctx)).toBe("'hi'")
    expect(compileExpr(literal(42), ctx)).toBe('42')
    expect(compileExpr(literal(true), ctx)).toBe('TRUE')
    expect(compileExpr(literal(null), ctx)).toBe('NULL')
  })

  it('compiles columns unqualified by default', () => {
    expect(compileExpr(col('tenant_id'), baseCtx())).toBe('tenant_id')
  })

  it('quotes columns with uppercase or special chars', () => {
    expect(compileExpr(col('TenantId'), baseCtx())).toBe('"TenantId"')
  })

  it('qualifies columns when ctx.qualifyColumns is true', () => {
    expect(compileExpr(col('tenant_id'), baseCtx({ qualifyColumns: true }))).toBe('workbench.tenant_id')
  })
})

describe('compileExpr — claim', () => {
  it('scalar uuid claim casts to uuid', () => {
    expect(compileExpr(claim('tenantId'), baseCtx())).toBe(
      "((current_setting('request.jwt.claims', true)::json ->> 'tenantId'))::uuid"
    )
  })

  it('scalar integer claim casts to integer', () => {
    expect(compileExpr(claim('age'), baseCtx())).toBe(
      "((current_setting('request.jwt.claims', true)::json ->> 'age'))::integer"
    )
  })

  it('scalar boolean claim casts to boolean', () => {
    expect(compileExpr(claim('active'), baseCtx())).toBe(
      "((current_setting('request.jwt.claims', true)::json ->> 'active'))::boolean"
    )
  })

  it('array claim returns jsonb form (no cast)', () => {
    expect(compileExpr(claim('workspaceIds'), baseCtx())).toBe(
      "(current_setting('request.jwt.claims', true)::jsonb -> 'workspaceIds')"
    )
  })

  it('throws on unknown claim', () => {
    expect(() => compileExpr(claim('ghost'), baseCtx())).toThrow(/unknown claim "ghost"/)
  })
})

describe('compileExpr — binops and logical', () => {
  it.each([
    ['eq', '='],
    ['neq', '<>'],
    ['lt', '<'],
    ['lte', '<='],
    ['gt', '>'],
    ['gte', '>='],
  ] as const)('compiles %s as %s', (op, sql) => {
    expect(compileExpr(binop(op, col('a'), col('b')), baseCtx())).toBe(`(a ${sql} b)`)
  })

  it('compiles AND with two operands', () => {
    expect(compileExpr(and(col('a'), col('b')), baseCtx())).toBe('(a AND b)')
  })

  it('compiles AND with three operands', () => {
    expect(compileExpr(and(col('a'), col('b'), col('c')), baseCtx())).toBe('(a AND b AND c)')
  })

  it('compiles AND with zero operands as TRUE', () => {
    expect(compileExpr(and(), baseCtx())).toBe('TRUE')
  })

  it('compiles AND with one operand as that operand', () => {
    expect(compileExpr(and(col('only')), baseCtx())).toBe('only')
  })

  it('compiles OR with zero operands as FALSE', () => {
    expect(compileExpr(or(), baseCtx())).toBe('FALSE')
  })

  it('compiles OR with two operands', () => {
    expect(compileExpr(or(col('a'), col('b')), baseCtx())).toBe('(a OR b)')
  })

  it('compiles NOT', () => {
    expect(compileExpr(not(col('a')), baseCtx())).toBe('(NOT a)')
  })
})

describe('compileExpr — hasRole (default strategy)', () => {
  it('compiles scope-less hasRole via jsonb ? operator on the roles claim', () => {
    expect(compileExpr(hasRole('workspace.admin'), baseCtx())).toBe(
      "((current_setting('request.jwt.claims', true)::jsonb -> 'roles') ? 'workspace.admin')"
    )
  })

  it('compiles scoped hasRole inline against the roleScopes claim — no helper function dependency', () => {
    expect(compileExpr(hasRole('workspace.admin', 'workspace_id'), baseCtx({ qualifyColumns: true }))).toBe(
      "((current_setting('request.jwt.claims', true)::jsonb -> 'roleScopes' -> 'workspace.admin') ? (workbench.workspace_id)::text)"
    )
  })

  it('emitted scoped hasRole never references app.has_role_on or any consumer helper', () => {
    const sql = compileExpr(hasRole('workspace.admin', 'workspace_id'), baseCtx())
    expect(sql).not.toContain('app.has_role_on')
    expect(sql).not.toMatch(/\bapp\./)
    // current_setting (built-in) is allowed; we're checking we don't add OUR own helpers.
    expect(sql).toContain('current_setting')
  })

  it('honors an overridden compileHasRole', () => {
    const custom = compileExpr(hasRole('x'), baseCtx({ compileHasRole: () => 'CUSTOM' }))
    expect(custom).toBe('CUSTOM')
  })

  it('default helpers compose with predicates', () => {
    const ctx = baseCtx({ qualifyColumns: true })
    expect(defaultCompileHasRole('a', undefined, ctx)).toContain("? 'a'")
    expect(defaultCompileHasRole('a', 'workbench.id', ctx)).toContain("'roleScopes' -> 'a'")
  })
})

describe('compileExpr — isOwner (default strategy)', () => {
  it('compiles isOwner as col = (sub claim)::uuid', () => {
    expect(compileExpr(isOwner('owner_id'), baseCtx())).toBe(
      "(owner_id = (current_setting('request.jwt.claims', true)::json ->> 'sub')::uuid)"
    )
  })

  it('honors an overridden compileIsOwner', () => {
    expect(compileExpr(isOwner('owner_id'), baseCtx({ compileIsOwner: () => 'CUSTOM_OWNER' }))).toBe('CUSTOM_OWNER')
  })

  it('default helpers compose with predicates', () => {
    const ctx = baseCtx({ qualifyColumns: true })
    expect(defaultCompileIsOwner('workbench.owner_id', ctx)).toContain('workbench.owner_id =')
  })
})

describe('compileExpr — inArray', () => {
  it('uses jsonb ? operator with text cast on needle', () => {
    expect(compileExpr(inArray(col('workspace_id'), claim('workspaceIds')), baseCtx())).toBe(
      "((current_setting('request.jwt.claims', true)::jsonb -> 'workspaceIds') ? (workspace_id)::text)"
    )
  })
})

describe('compileExpr — raw', () => {
  it('wraps the raw SQL in parens', () => {
    expect(compileExpr(raw('tenant_id IS NOT NULL'), baseCtx())).toBe('(tenant_id IS NOT NULL)')
  })
})
