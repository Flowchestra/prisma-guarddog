import { describe, expect, it } from 'vitest'

import { defineAppRoles } from './app-roles.js'
import type { Expr, PolicyAst } from './ast.js'
import { defineClaims } from './claims.js'
import { defineDbRoles } from './db-roles.js'
import { Guarddog } from './guarddog.js'
import { col } from './predicate.js'
import { defineResources } from './resources.js'

function makeGuard() {
  return new Guarddog({
    claims: defineClaims({
      accessor: 'request.jwt.claims',
      shape: (c) => ({
        sub: c.uuid(),
        tenantId: c.uuid(),
        workspaceIds: c.array(c.uuid()),
        roles: c.array(c.string()),
      }),
    }),
    dbRoles: defineDbRoles({
      app_user: { inherits: [] },
      app_system: { inherits: ['app_user'], bypassesRls: true },
    }),
    appRoles: defineAppRoles({
      'workspace.admin': {},
      'workspace.editor': {},
    }),
    resources: defineResources({
      Tenant: { model: 'Tenant', id: 'id', children: ['Workspace'] },
      Workspace: {
        model: 'Workspace',
        id: 'id',
        parent: { resource: 'Tenant', column: 'tenantId' },
        children: ['Workbench'],
      },
      Workbench: {
        model: 'Workbench',
        id: 'id',
        parent: { resource: 'Workspace', column: 'workspaceId' },
      },
    }),
  })
}

describe('Guarddog.model().policy()', () => {
  it('registers a SELECT policy and exposes it via getPolicies()', () => {
    const guard = makeGuard()
    guard
      .model('Workbench')
      .policy('app_user')
      .select((p) =>
        p
          .claim('tenantId')
          .eq(col('tenantId'))
          .and(p.hasGrant('workspace.admin', col('workspaceId')))
      )

    const policies = guard.getPolicies()
    expect(policies).toHaveLength(1)
    const policy = policies[0] as PolicyAst
    expect(policy.model).toBe('Workbench')
    expect(policy.dbRole).toBe('app_user')
    expect(policy.select?.using.kind).toBe('and')
  })

  it('idempotent on repeated model() and policy() calls (same key returns same builder)', () => {
    const guard = makeGuard()
    const a = guard.model('Workbench').policy('app_user')
    const b = guard.model('Workbench').policy('app_user')
    expect(a).toBe(b)
    expect(guard.getPolicies()).toHaveLength(1)
  })

  it('registers distinct policies for different (model, dbRole) pairs', () => {
    const guard = makeGuard()
    guard
      .model('Workbench')
      .policy('app_user')
      .select((p) => p.literal(true))
    guard
      .model('Workbench')
      .policy('app_system')
      .select((p) => p.literal(true))
    guard
      .model('Workspace')
      .policy('app_user')
      .select((p) => p.literal(true))
    expect(guard.getPolicies()).toHaveLength(3)
  })

  it('all four verbs land on the same PolicyAst', () => {
    const guard = makeGuard()
    guard
      .model('Workbench')
      .policy('app_user')
      .select((p) => p.claim('tenantId').eq(col('tenantId')))
      .insert({ check: (p) => p.hasGrant('workspace.editor', col('workspaceId')) })
      .update({
        using: (p) => p.isOwner(col('ownerId')),
        check: (p) => p.hasGrant('workspace.admin', col('workspaceId')),
      })
      .delete({ using: (p) => p.hasGrant('workspace.admin', col('workspaceId')) })

    const policy = guard.getPolicies()[0] as PolicyAst
    expect(policy.select?.using.kind).toBe('binop')
    expect(policy.insert?.check.kind).toBe('hasGrant')
    expect(policy.update?.using.kind).toBe('isOwner')
    expect(policy.update?.check.kind).toBe('hasGrant')
    expect(policy.delete?.using.kind).toBe('hasGrant')
  })

  it('UPDATE requires both using and check (ADR-0005 — no inference)', () => {
    const guard = makeGuard()
    const builder = guard.model('Workbench').policy('app_user')
    // The API signature forces the caller to pass both keys at the type level.
    // Passing only one is a type error at compile time. This test verifies
    // both end up in the AST when both are provided.
    builder.update({
      using: (p) => p.literal(true),
      check: (p) => p.literal(false),
    })
    const policy = guard.getPolicies()[0] as PolicyAst
    expect(policy.update).toBeDefined()
    if (policy.update === undefined) return
    expect((policy.update.using as Extract<Expr, { kind: 'literal' }>).value).toBe(true)
    expect((policy.update.check as Extract<Expr, { kind: 'literal' }>).value).toBe(false)
  })

  it('returns deeply-frozen AST from getPolicies()', () => {
    const guard = makeGuard()
    guard
      .model('Workbench')
      .policy('app_user')
      .select((p) => p.claim('tenantId').eq(col('tenantId')))

    const policies = guard.getPolicies()
    expect(Object.isFrozen(policies)).toBe(true)
    expect(Object.isFrozen(policies[0])).toBe(true)
    expect(Object.isFrozen(policies[0]?.select)).toBe(true)
    expect(Object.isFrozen(policies[0]?.select?.using)).toBe(true)
  })

  it('table() override propagates to the AST', () => {
    const guard = makeGuard()
    guard
      .model('Workbench')
      .table('public.workbenches_v2')
      .policy('app_user')
      .select((p) => p.literal(true))

    const policy = guard.getPolicies()[0] as PolicyAst
    expect(policy.table).toBe('public.workbenches_v2')
  })

  it('table() can be omitted (table is undefined on AST)', () => {
    const guard = makeGuard()
    guard
      .model('Workbench')
      .policy('app_user')
      .select((p) => p.literal(true))
    expect(guard.getPolicies()[0]?.table).toBeUndefined()
  })
})

describe('Guarddog input validation', () => {
  it('rejects empty model name', () => {
    expect(() => makeGuard().model('')).toThrow(/modelName must be a non-empty string/)
  })

  it('@ts-expect-error: claim() is type-checked against the registered shape', () => {
    const guard = makeGuard()
    guard
      .model('Workbench')
      .policy('app_user')
      .select((p) =>
        // @ts-expect-error — 'ghost' is not a key of the declared claims shape
        p.claim('ghost').eq(col('x'))
      )
    // Runtime still creates the predicate (with kind: 'claim', path: 'ghost')
    // — the type system catches it at author time; runtime does not.
    expect(guard.getPolicies()).toHaveLength(1)
  })

  it('@ts-expect-error: policy() is type-checked against the registered dbRoles', () => {
    const guard = makeGuard()
    guard
      .model('Workbench')
      // @ts-expect-error — 'unknown_role' is not in the registered dbRoles
      .policy('unknown_role')
      .select((p) => p.literal(true))
    expect(guard.getPolicies()).toHaveLength(1)
  })
})
