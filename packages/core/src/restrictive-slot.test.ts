/**
 * Tests for ADR-0033 — named slots for restrictive policies. Multiple
 * restrictive invariants on the same (model, dbRole) via slot keys.
 */

import { describe, expect, it } from 'vitest'

import { defineAppRoles } from './app-roles.js'
import { defineClaims } from './claims.js'
import { defineDbRoles } from './db-roles.js'
import { DEFAULT_RESTRICTIVE_SLOT, Guarddog } from './guarddog.js'
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

describe('RestrictivePolicyBuilder — named slots (ADR-0033)', () => {
  it('defaults the slot to "default" when omitted (preserves alpha.14 keying)', () => {
    const guard = makeGuard()
    const a = guard.model('Workspace').restrictivePolicy('public')
    const b = guard.model('Workspace').restrictivePolicy('public')
    expect(a).toBe(b)
    expect(a.slot).toBe(DEFAULT_RESTRICTIVE_SLOT)
  })

  it('two distinct slots on the same (model, role) get independent builders', () => {
    const guard = makeGuard()
    const boundary = guard.model('Workspace').restrictivePolicy('public', 'boundary')
    const noSoftDeleted = guard.model('Workspace').restrictivePolicy('public', 'no_soft_deleted')
    expect(boundary).not.toBe(noSoftDeleted)
    expect(boundary.slot).toBe('boundary')
    expect(noSoftDeleted.slot).toBe('no_soft_deleted')
  })

  it('same slot returns the same builder (idempotent within a slot)', () => {
    const guard = makeGuard()
    const a = guard.model('Workspace').restrictivePolicy('public', 'boundary')
    const b = guard.model('Workspace').restrictivePolicy('public', 'boundary')
    expect(a).toBe(b)
  })

  it('emits one create-policy op per declared slot', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .restrictivePolicy('public', 'boundary')
      .forAll((p) => p.claim('tenantId').eq(col('tenant_id')))
    guard
      .model('Workspace')
      .restrictivePolicy('public', 'no_soft_deleted')
      .forAll((p) => p.raw('deleted_at IS NULL'))
    const ops = createPolicyOps(compileToOps(guard))
    expect(ops).toHaveLength(2)
    const names = ops.map((o) => o.name).toSorted()
    expect(names).toEqual(['workspace_public_boundary', 'workspace_public_no_soft_deleted'])
  })

  it('low-level slot auto-name keeps the role: <table>_<role>_<slot>', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .restrictivePolicy('app_user', 'boundary')
      .forAll((p) => p.literal(true))
    const ops = createPolicyOps(compileToOps(guard))
    expect(ops[0]!.name).toBe('workspace_app_user_boundary')
  })

  it('rejects empty slot strings', () => {
    const guard = makeGuard()
    expect(() => guard.model('Workspace').restrictivePolicy('public', '')).toThrow(/non-empty/)
  })
})

describe('ModelBuilder.isolation() — overloaded slot form (ADR-0033)', () => {
  it('legacy `.isolation(fn)` preserves the alpha.14 auto-name <table>_isolation', () => {
    const guard = makeGuard()
    guard.model('Workspace').isolation((p) => p.claim('tenantId').eq(col('tenant_id')))
    const ops = createPolicyOps(compileToOps(guard))
    expect(ops).toHaveLength(1)
    expect(ops[0]!.name).toBe('workspace_isolation')
  })

  it('slot-form `.isolation(slot, fn)` auto-names as <table>_<slot> (no role suffix)', () => {
    const guard = makeGuard()
    guard.model('Workspace').isolation('boundary', (p) => p.claim('tenantId').eq(col('tenant_id')))
    const ops = createPolicyOps(compileToOps(guard))
    expect(ops[0]!.name).toBe('workspace_boundary')
  })

  it('two `.isolation(slot, fn)` calls coexist as distinct policies', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .isolation('boundary', (p) => p.claim('tenantId').eq(col('tenant_id')))
      .isolation('no_soft_deleted', (p) => p.raw('deleted_at IS NULL'))
    const ops = createPolicyOps(compileToOps(guard))
    expect(ops).toHaveLength(2)
    expect(ops.map((o) => o.name).toSorted()).toEqual(['workspace_boundary', 'workspace_no_soft_deleted'])
    for (const op of ops) {
      expect(op.restrictive).toBe(true)
      expect(op.dbRole).toBe('public')
      expect(op.verb).toBe('all')
    }
  })

  it('the slot-form still passes through `{ name }` overrides (ADR-0031)', () => {
    const guard = makeGuard()
    guard.model('Workspace').isolation('boundary', (p) => p.literal(true), { name: 'legacy_boundary_policy' })
    const ops = createPolicyOps(compileToOps(guard))
    expect(ops[0]!.name).toBe('legacy_boundary_policy')
  })

  it('alpha.14 default-slot `.isolation(fn)` and a slot-form `.isolation(slot, fn)` coexist', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .isolation((p) => p.claim('tenantId').eq(col('tenant_id')))
      .isolation('no_soft_deleted', (p) => p.raw('deleted_at IS NULL'))
    const ops = createPolicyOps(compileToOps(guard))
    expect(ops.map((o) => o.name).toSorted()).toEqual(['workspace_isolation', 'workspace_no_soft_deleted'])
  })

  it('repeated `.isolation(slot, fn)` with the same slot overwrites the predicate', () => {
    const guard = makeGuard()
    guard.model('Workspace').isolation('boundary', (p) => p.literal(false))
    guard.model('Workspace').isolation('boundary', (p) => p.literal(true))
    const ops = createPolicyOps(compileToOps(guard))
    expect(ops).toHaveLength(1)
    expect(ops[0]!.using).toEqual({ kind: 'literal', value: true })
  })

  it('two declared names that collide on (table, name) still throw the duplicate-name guard', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .isolation('a', (p) => p.literal(true), { name: 'shared' })
      .isolation('b', (p) => p.literal(true), { name: 'shared' })
    expect(() => compileToOps(guard)).toThrow(/duplicate policy name/)
  })
})
