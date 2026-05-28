import { describe, expect, it } from 'vitest'

import type { Expr } from './ast.js'
import { col, FluentExpr, PredicateBuilder } from './predicate.js'

interface DemoClaims {
  sub: string
  tenantId: string
  workspaceIds: string[]
  roles: string[]
}

const p = new PredicateBuilder<DemoClaims>()

describe('col()', () => {
  it('builds a frozen col Expr', () => {
    const c = col('tenantId')
    expect(c.ast).toEqual({ kind: 'col', column: 'tenantId' })
    expect(Object.isFrozen(c)).toBe(true)
    expect(Object.isFrozen(c.ast)).toBe(true)
  })

  it('rejects empty column name', () => {
    expect(() => col('')).toThrow(/column name must be a non-empty string/)
  })
})

describe('PredicateBuilder.claim', () => {
  it('builds a frozen claim Expr', () => {
    const e = p.claim('tenantId')
    expect(e.ast).toEqual({ kind: 'claim', path: 'tenantId' })
    expect(Object.isFrozen(e.ast)).toBe(true)
  })

  // Type-check (compile-time): `claim('ghost')` should be a type error
  // because 'ghost' is not a key of DemoClaims. We can't easily assert
  // type errors at runtime without ts-expect-error in production code,
  // so this is enforced by the @ts-expect-error in guarddog.test.ts.
})

describe('PredicateBuilder binary operators', () => {
  it.each(['eq', 'neq', 'lt', 'lte', 'gt', 'gte'] as const)('builds a %s binop', (op) => {
    const fluent = (p.claim('tenantId') as FluentExpr)[op](col('tenantId'))
    expect(fluent.ast).toEqual({
      kind: 'binop',
      op,
      left: { kind: 'claim', path: 'tenantId' },
      right: { kind: 'col', column: 'tenantId' },
    })
  })

  it('functional form matches fluent form', () => {
    const fluent = p.claim('tenantId').eq(col('tenantId'))
    const functional = p.eq(p.claim('tenantId'), col('tenantId'))
    expect(fluent.ast).toEqual(functional.ast)
  })
})

describe('PredicateBuilder logical combinators', () => {
  it('builds AND of multiple operands (functional)', () => {
    const a = p.claim('tenantId').eq(col('tenantId'))
    const b = p.hasGrant('workspace.admin', col('workspaceId'))
    const c = p.isOwner(col('ownerId'))
    const e = p.and(a, b, c).ast as Extract<Expr, { kind: 'and' }>
    expect(e.kind).toBe('and')
    expect(e.operands).toHaveLength(3)
  })

  it('builds OR of multiple operands', () => {
    const e = p.or(p.literal(true), p.literal(false)).ast as Extract<Expr, { kind: 'or' }>
    expect(e.kind).toBe('or')
    expect(e.operands).toHaveLength(2)
  })

  it('builds NOT', () => {
    const e = p.not(p.literal(true)).ast as Extract<Expr, { kind: 'not' }>
    expect(e.kind).toBe('not')
    expect(e.operand).toEqual({ kind: 'literal', value: true })
  })

  it('fluent and() chains pairwise', () => {
    const a = p.literal(true)
    const b = p.literal(false)
    const c = p.literal(null)
    const chain = a.and(b).and(c).ast as Extract<Expr, { kind: 'and' }>
    expect(chain.kind).toBe('and')
    // Chained .and() pairs left-deep: ((a AND b) AND c)
    expect(chain.operands).toHaveLength(2)
    const inner = chain.operands[0] as Extract<Expr, { kind: 'and' }>
    expect(inner.kind).toBe('and')
    expect(inner.operands).toHaveLength(2)
    expect(chain.operands[1]).toEqual({ kind: 'literal', value: null })
  })
})

describe('PredicateBuilder.hasAppRole (layer 2)', () => {
  it('builds a hasAppRole Expr from a role string', () => {
    expect(p.hasAppRole('workspace.admin').ast).toEqual({
      kind: 'hasAppRole',
      role: 'workspace.admin',
    })
  })

  it('rejects empty role name', () => {
    expect(() => p.hasAppRole('')).toThrow(/role name must be a non-empty string/)
  })
})

describe('PredicateBuilder.hasGrant (layer 3)', () => {
  it('builds a hasGrant Expr scoped to a column', () => {
    expect(p.hasGrant('edit', col('workspaceId')).ast).toEqual({
      kind: 'hasGrant',
      action: 'edit',
      scopeColumn: 'workspaceId',
    })
  })

  it('rejects empty action name', () => {
    expect(() => p.hasGrant('', col('workspaceId'))).toThrow(/action name must be a non-empty string/)
  })

  it('rejects non-column scope argument', () => {
    expect(() => p.hasGrant('edit', p.literal(true))).toThrow(/scopeColumn must be a column reference/)
  })

  it('carries an opts.table hint into the AST as tableHint', () => {
    expect(p.hasGrant('edit', col('id'), { table: 'workspaceId' }).ast).toEqual({
      kind: 'hasGrant',
      action: 'edit',
      scopeColumn: 'id',
      tableHint: 'workspaceId',
    })
  })

  it('omits tableHint when opts is not provided', () => {
    expect(p.hasGrant('edit', col('workspaceId')).ast).not.toHaveProperty('tableHint')
  })

  it('rejects an empty opts.table', () => {
    expect(() => p.hasGrant('edit', col('id'), { table: '' })).toThrow(/opts.table must be a non-empty string/)
  })
})

describe('PredicateBuilder.hasResourcePermission (per-resource jsonb)', () => {
  it('builds a hasResourcePermission Expr from a jsonb column ref', () => {
    expect(p.hasResourcePermission('read', col('permissions')).ast).toEqual({
      kind: 'hasResourcePermission',
      action: 'read',
      jsonbColumn: 'permissions',
    })
  })

  it('rejects empty action name', () => {
    expect(() => p.hasResourcePermission('', col('permissions'))).toThrow(/action name must be a non-empty string/)
  })

  it('rejects non-column jsonb argument', () => {
    expect(() => p.hasResourcePermission('read', p.literal(true))).toThrow(/jsonbColumn must be a column reference/)
  })
})

describe('PredicateBuilder.isOwner', () => {
  it('builds an isOwner Expr from a column ref', () => {
    expect(p.isOwner(col('ownerId')).ast).toEqual({ kind: 'isOwner', ownerColumn: 'ownerId' })
  })

  it('rejects non-column argument', () => {
    expect(() => p.isOwner(p.literal('x'))).toThrow(/ownerColumn must be a column reference/)
  })
})

describe('PredicateBuilder.inArray', () => {
  it('builds an inArray Expr', () => {
    const e = p.inArray(col('workspaceId'), p.claim('workspaceIds')).ast
    expect(e).toEqual({
      kind: 'inArray',
      needle: { kind: 'col', column: 'workspaceId' },
      haystack: { kind: 'claim', path: 'workspaceIds' },
    })
  })
})

describe('PredicateBuilder.raw', () => {
  it('builds a raw Expr', () => {
    const e = p.raw("current_setting('app.tenant_id', true) IS NOT NULL").ast
    expect(e).toEqual({
      kind: 'raw',
      sql: "current_setting('app.tenant_id', true) IS NOT NULL",
    })
  })

  it('rejects empty SQL', () => {
    expect(() => p.raw('')).toThrow(/SQL fragment must be a non-empty string/)
  })
})

describe('PredicateBuilder.literal', () => {
  it.each([
    ['string', 'hello'],
    ['number', 42],
    ['boolean', true],
    ['null', null],
  ])('captures %s literal', (_label, value) => {
    expect(p.literal(value as never).ast).toEqual({ kind: 'literal', value })
  })
})
