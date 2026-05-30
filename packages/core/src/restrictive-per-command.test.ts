/**
 * Tests for ADR-0034 — per-command restrictive policies (`.forSelect()` /
 * `.forInsert()` / `.forUpdate()` / `.forDelete()`).
 */

import { describe, expect, it } from 'vitest'

import { defineAppRoles } from './app-roles.js'
import { defineClaims } from './claims.js'
import { defineDbRoles } from './db-roles.js'
import { Guarddog } from './guarddog.js'
import { compileToOps } from './lifecycle.js'
import { type Op, type PolicyOpRecord } from './ops.js'
import { col } from './predicate.js'
import { defineResources } from './resources.js'

function makeGuard() {
  return new Guarddog({
    claims: defineClaims({ accessor: 'request.jwt.claims', shape: (c) => ({ sub: c.uuid(), tenantId: c.uuid() }) }),
    dbRoles: defineDbRoles({ app_user: { inherits: [], nologin: true } }),
    appRoles: defineAppRoles({}),
    resources: defineResources({}),
  })
}

function createPolicyOps(ops: ReadonlyArray<Op>): PolicyOpRecord[] {
  return ops.filter((o): o is Extract<Op, { kind: 'create-policy' }> => o.kind === 'create-policy').map((o) => o.policy)
}

describe('RestrictivePolicyBuilder.forSelect (ADR-0034)', () => {
  it('emits a restrictive SELECT-only policy with USING-only', () => {
    const guard = makeGuard()
    guard
      .model('Widget')
      .restrictivePolicy('public')
      .forSelect((p) => p.raw('deleted_at IS NULL'))
    const ops = createPolicyOps(compileToOps(guard))
    expect(ops).toHaveLength(1)
    const op = ops[0]!
    expect(op.restrictive).toBe(true)
    expect(op.verb).toBe('select')
    expect(op.using).toBeDefined()
    expect(op.check).toBeUndefined()
    expect(op.name).toBe('widget_public_select')
  })

  it('honors a slot in the auto-name (ADR-0033): `<table>_<role>_<slot>_<verb>`', () => {
    const guard = makeGuard()
    guard
      .model('Widget')
      .restrictivePolicy('public', 'no_soft_deleted')
      .forSelect((p) => p.raw('deleted_at IS NULL'))
    const op = createPolicyOps(compileToOps(guard))[0]!
    expect(op.name).toBe('widget_public_no_soft_deleted_select')
  })

  it('per-call `{ name }` override wins (ADR-0031)', () => {
    const guard = makeGuard()
    guard
      .model('Widget')
      .restrictivePolicy('public')
      .forSelect((p) => p.literal(true), { name: 'legacy_select_floor' })
    const op = createPolicyOps(compileToOps(guard))[0]!
    expect(op.name).toBe('legacy_select_floor')
  })
})

describe('RestrictivePolicyBuilder.forInsert / forUpdate / forDelete (ADR-0034)', () => {
  it('forInsert emits WITH CHECK only', () => {
    const guard = makeGuard()
    guard
      .model('Widget')
      .restrictivePolicy('public')
      .forInsert({ check: (p) => p.claim('tenantId').eq(col('tenant_id')) })
    const op = createPolicyOps(compileToOps(guard))[0]!
    expect(op.verb).toBe('insert')
    expect(op.restrictive).toBe(true)
    expect(op.using).toBeUndefined()
    expect(op.check).toBeDefined()
  })

  it('forUpdate emits both USING and WITH CHECK', () => {
    const guard = makeGuard()
    guard
      .model('Widget')
      .restrictivePolicy('public')
      .forUpdate({
        using: (p) => p.claim('tenantId').eq(col('tenant_id')),
        check: (p) => p.claim('tenantId').eq(col('tenant_id')),
      })
    const op = createPolicyOps(compileToOps(guard))[0]!
    expect(op.verb).toBe('update')
    expect(op.restrictive).toBe(true)
    expect(op.using).toBeDefined()
    expect(op.check).toBeDefined()
  })

  it('forDelete emits USING only', () => {
    const guard = makeGuard()
    guard
      .model('Widget')
      .restrictivePolicy('public')
      .forDelete({ using: (p) => p.claim('tenantId').eq(col('tenant_id')) })
    const op = createPolicyOps(compileToOps(guard))[0]!
    expect(op.verb).toBe('delete')
    expect(op.restrictive).toBe(true)
    expect(op.using).toBeDefined()
    expect(op.check).toBeUndefined()
  })

  it('multiple per-verb methods on the same builder emit one policy per declared verb', () => {
    const guard = makeGuard()
    guard
      .model('Widget')
      .restrictivePolicy('public', 'writes')
      .forInsert({ check: (p) => p.literal(true) })
      .forUpdate({ using: (p) => p.literal(true), check: (p) => p.literal(true) })
      .forDelete({ using: (p) => p.literal(true) })
    const ops = createPolicyOps(compileToOps(guard))
    expect(ops).toHaveLength(3)
    expect(ops.every((o) => o.restrictive === true)).toBe(true)
    expect(ops.map((o) => o.verb).toSorted()).toEqual(['delete', 'insert', 'update'])
  })
})

describe('Mutex guard: .forAll() vs per-verb methods (ADR-0034)', () => {
  it('throws when .forSelect is called after .forAll on the same builder', () => {
    const guard = makeGuard()
    const builder = guard
      .model('Widget')
      .restrictivePolicy('public')
      .forAll((p) => p.literal(true))
    expect(() => builder.forSelect((p) => p.literal(true))).toThrow(/cannot combine per-verb methods with \.forAll/)
  })

  it('throws when .forAll is called after .forSelect on the same builder', () => {
    const guard = makeGuard()
    const builder = guard
      .model('Widget')
      .restrictivePolicy('public')
      .forSelect((p) => p.literal(true))
    expect(() => builder.forAll((p) => p.literal(true))).toThrow(/cannot combine \.forAll/)
  })

  it('throws on the second per-verb-then-forAll combination', () => {
    const guard = makeGuard()
    const builder = guard
      .model('Widget')
      .restrictivePolicy('public')
      .forUpdate({ using: (p) => p.literal(true), check: (p) => p.literal(true) })
    expect(() => builder.forAll((p) => p.literal(true))).toThrow(/cannot combine \.forAll/)
  })

  it('does NOT throw when two distinct slots hold .forAll and per-verb separately', () => {
    const guard = makeGuard()
    expect(() => {
      guard
        .model('Widget')
        .restrictivePolicy('public', 'boundary')
        .forAll((p) => p.literal(true))
      guard
        .model('Widget')
        .restrictivePolicy('public', 'no_soft_deleted')
        .forSelect((p) => p.raw('deleted_at IS NULL'))
    }).not.toThrow()
    const ops = createPolicyOps(compileToOps(guard))
    expect(ops).toHaveLength(2)
    const verbs = ops.map((o) => o.verb).toSorted()
    expect(verbs).toEqual(['all', 'select'])
  })
})

describe('Per-command restrictives emit `AS RESTRICTIVE FOR <verb>`', () => {
  it('the canonical soft-delete shape: SELECT-only restrictive', () => {
    const guard = makeGuard()
    guard
      .model('Widget')
      .restrictivePolicy('public', 'no_soft_deleted')
      .forSelect((p) => p.raw('deleted_at IS NULL'))
    const op = createPolicyOps(compileToOps(guard))[0]!
    expect(op.restrictive).toBe(true)
    expect(op.verb).toBe('select')
    expect(op.dbRole).toBe('public')
    // <table>_<role>_<slot>_<verb> convention (ADR-0034)
    expect(op.name).toBe('widget_public_no_soft_deleted_select')
  })

  it('coexists with .isolation() in a different slot', () => {
    const guard = makeGuard()
    guard
      .model('Widget')
      .isolation('boundary', (p) => p.claim('tenantId').eq(col('tenant_id')))
      .restrictivePolicy('public', 'no_soft_deleted')
      .forSelect((p) => p.raw('deleted_at IS NULL'))
    const ops = createPolicyOps(compileToOps(guard))
    expect(ops).toHaveLength(2)
    const names = ops.map((o) => o.name).toSorted()
    expect(names).toEqual(['widget_boundary', 'widget_public_no_soft_deleted_select'])
    expect(ops.every((o) => o.restrictive === true)).toBe(true)
  })
})
