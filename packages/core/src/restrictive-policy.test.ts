/**
 * Tests for ADR-0032 — restrictive policy support (`.restrictivePolicy()` +
 * `.isolation()` sugar).
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

describe('RestrictivePolicyBuilder (ADR-0032)', () => {
  it('produces an AST with restrictive=true and an `all` spec', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .restrictivePolicy('public')
      .forAll((p) => p.claim('tenantId').eq(col('tenant_id')))
    const pols = guard.getPolicies()
    expect(pols).toHaveLength(1)
    const pol = pols[0]!
    expect(pol.restrictive).toBe(true)
    expect(pol.all).toBeDefined()
    expect(pol.select).toBeUndefined()
    expect(pol.insert).toBeUndefined()
    expect(pol.update).toBeUndefined()
    expect(pol.delete).toBeUndefined()
  })

  it('the `all` spec uses the same predicate for USING and WITH CHECK', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .restrictivePolicy('public')
      .forAll((p) => p.claim('tenantId').eq(col('tenant_id')))
    const pol = guard.getPolicies()[0]!
    expect(pol.all!.using).toEqual(pol.all!.check)
  })

  it('is idempotent across repeated `.restrictivePolicy(role)` calls', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .restrictivePolicy('public')
      .forAll((p) => p.literal(true))
    guard
      .model('Workspace')
      .restrictivePolicy('public')
      .forAll((p) => p.claim('tenantId').eq(col('tenant_id')))
    // Same builder; the second forAll() overwrites the first.
    const pols = guard.getPolicies()
    expect(pols).toHaveLength(1)
    expect(pols[0]!.all!.using.kind).toBe('binop')
  })

  it('per-call `.forAll(fn, { name })` overrides the auto-generated name', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .restrictivePolicy('public')
      .forAll((p) => p.literal(true), { name: 'tenant_floor' })
    const ops = createPolicyOps(compileToOps(guard))
    expect(ops).toHaveLength(1)
    expect(ops[0]!.name).toBe('tenant_floor')
    expect(ops[0]!.restrictive).toBe(true)
    expect(ops[0]!.verb).toBe('all')
  })

  it('chained `.named()` persists across the `.forAll()` call', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .restrictivePolicy('public')
      .named('tenant_floor')
      .forAll((p) => p.literal(true))
    const ops = createPolicyOps(compileToOps(guard))
    expect(ops[0]!.name).toBe('tenant_floor')
  })

  it('rejects empty declared names', () => {
    const guard = makeGuard()
    expect(() => {
      guard
        .model('Workspace')
        .restrictivePolicy('public')
        .forAll((p) => p.literal(true), { name: '' })
    }).toThrow(/non-empty string/)
  })
})

describe('ModelBuilder.isolation() sugar (ADR-0032)', () => {
  it('desugars to `.restrictivePolicy("public").forAll(...)` with isolation=true', () => {
    const guard = makeGuard()
    guard.model('Workspace').isolation((p) => p.claim('tenantId').eq(col('tenant_id')))
    const pols = guard.getPolicies()
    expect(pols).toHaveLength(1)
    const pol = pols[0]!
    expect(pol.restrictive).toBe(true)
    expect(pol.isolation).toBe(true)
    expect(pol.dbRole).toBe('public')
    expect(pol.all).toBeDefined()
  })

  it('auto-names the emitted policy `<table>_isolation`', () => {
    const guard = makeGuard()
    guard.model('Workspace').isolation((p) => p.claim('tenantId').eq(col('tenant_id')))
    const ops = createPolicyOps(compileToOps(guard))
    expect(ops[0]!.name).toBe('workspace_isolation')
    expect(ops[0]!.restrictive).toBe(true)
  })

  it('honors a table override when picking the auto-name', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .table('workspaces')
      .isolation((p) => p.literal(true))
    const ops = createPolicyOps(compileToOps(guard))
    expect(ops[0]!.name).toBe('workspaces_isolation')
  })

  it('accepts an opts.name override for legacy-name parity (pairs with ADR-0031)', () => {
    const guard = makeGuard()
    guard.model('Workspace').isolation((p) => p.literal(true), { name: 'tenant_isolation' })
    const ops = createPolicyOps(compileToOps(guard))
    expect(ops[0]!.name).toBe('tenant_isolation')
  })

  it('returns `this` so chains can continue into permissive policies', () => {
    const guard = makeGuard()
    const builder = guard.model('Workspace').isolation((p) => p.literal(true))
    expect(builder).toBe(guard.model('Workspace'))
    builder.policy('app_user').select((p) => p.literal(true))
    expect(guard.getPolicies()).toHaveLength(2)
  })

  it('repeated calls overwrite the predicate (same underlying builder)', () => {
    const guard = makeGuard()
    guard.model('Workspace').isolation((p) => p.literal(false))
    guard.model('Workspace').isolation((p) => p.literal(true))
    const pols = guard.getPolicies()
    expect(pols).toHaveLength(1)
    expect(pols[0]!.all!.using).toEqual({ kind: 'literal', value: true })
  })
})

describe('lifecycle: restrictive policies (ADR-0032)', () => {
  it('emits exactly one create-policy op per restrictive declaration', () => {
    const guard = makeGuard()
    guard.model('Workspace').isolation((p) => p.literal(true))
    const ops = createPolicyOps(compileToOps(guard))
    expect(ops).toHaveLength(1)
    expect(ops[0]!.verb).toBe('all')
    expect(ops[0]!.restrictive).toBe(true)
  })

  it('coexists with permissive policies on the same model', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .isolation((p) => p.claim('tenantId').eq(col('tenant_id')))
      .policy('app_user')
      .select((p) => p.literal(true))
    const ops = createPolicyOps(compileToOps(guard))
    expect(ops).toHaveLength(2)
    const restrictive = ops.find((o) => o.restrictive === true)!
    const permissive = ops.find((o) => o.restrictive !== true)!
    expect(restrictive.verb).toBe('all')
    expect(restrictive.dbRole).toBe('public')
    expect(permissive.verb).toBe('select')
    expect(permissive.dbRole).toBe('app_user')
    // Both target the same table → RLS enabled exactly once for that table.
    const enableRls = compileToOps(guard).filter((o) => o.kind === 'enable-rls')
    expect(enableRls).toHaveLength(1)
  })

  it('rejects two restrictives sharing the same (table, declared name)', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .restrictivePolicy('public')
      .forAll((p) => p.literal(true), { name: 'tenant_floor' })
    // Different dbRole — registry key differs — but same (table, name) under override.
    // Use a low-level second restrictive with the same name.
    guard
      .model('Workspace')
      .restrictivePolicy('app_user')
      .forAll((p) => p.literal(true), { name: 'tenant_floor' })
    expect(() => compileToOps(guard)).toThrow(/duplicate policy name/)
  })
})
