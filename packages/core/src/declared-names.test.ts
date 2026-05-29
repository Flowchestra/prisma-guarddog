/**
 * Tests for ADR-0031 — opt-in user-declared policy names (`.named()` +
 * per-verb `{ name }`).
 */

import { describe, expect, it } from 'vitest'

import { defineAppRoles } from './app-roles.js'
import { defineClaims } from './claims.js'
import { defineDbRoles } from './db-roles.js'
import { Guarddog } from './guarddog.js'
import { compileToOps } from './lifecycle.js'
import { type Op } from './ops.js'
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

describe('PolicyBuilder declared names (ADR-0031)', () => {
  it('per-verb `{ name }` overrides the auto-generated name', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .policy('app_user')
      .select((p) => p.claim('tenantId').eq(col('tenantId')), { name: 'workspaces_visibility_select' })
    const pol = guard.getPolicies()[0]!
    expect(pol.select?.name).toBe('workspaces_visibility_select')
  })

  it('chained `.named()` persists across subsequent verb calls', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .policy('app_user')
      .named('workspaces_visibility_select')
      .select((p) => p.claim('tenantId').eq(col('tenantId')))
      .insert({ check: (p) => p.claim('tenantId').eq(col('tenantId')), name: 'workspaces_visibility_insert' }) // per-verb wins
      .update({
        using: (p) => p.claim('tenantId').eq(col('tenantId')),
        check: (p) => p.claim('tenantId').eq(col('tenantId')),
      }) // still 'workspaces_visibility_select'
      .delete({ using: (p) => p.claim('tenantId').eq(col('tenantId')) })
    const pol = guard.getPolicies()[0]!
    expect(pol.select?.name).toBe('workspaces_visibility_select')
    expect(pol.insert?.name).toBe('workspaces_visibility_insert')
    expect(pol.update?.name).toBe('workspaces_visibility_select')
    expect(pol.delete?.name).toBe('workspaces_visibility_select')
  })

  it('`.named(undefined)` resets the chained override', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .policy('app_user')
      .named('workspaces_visibility_select')
      .select((p) => p.claim('tenantId').eq(col('tenantId')))
      .named(undefined)
      .insert({ check: (p) => p.claim('tenantId').eq(col('tenantId')) })
    const pol = guard.getPolicies()[0]!
    expect(pol.select?.name).toBe('workspaces_visibility_select')
    expect(pol.insert?.name).toBeUndefined()
  })

  it('rejects an empty `.named()` and an empty per-verb name', () => {
    const guard = makeGuard()
    const builder = guard.model('Workspace').policy('app_user')
    expect(() => builder.named('')).toThrow(/non-empty string/)
    expect(() => builder.select((p) => p.claim('tenantId').eq(col('tenantId')), { name: '' })).toThrow(
      /non-empty string/
    )
  })

  it('no override → policy.<verb>.name stays undefined (auto-gen path)', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .policy('app_user')
      .select((p) => p.claim('tenantId').eq(col('tenantId')))
    const pol = guard.getPolicies()[0]!
    expect(pol.select?.name).toBeUndefined()
  })
})

describe('lifecycle (ADR-0031)', () => {
  it('flows declared name into the create-policy op name', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .policy('app_user')
      .named('workspaces_visibility_select')
      .select((p) => p.claim('tenantId').eq(col('tenantId')))
    const op = compileToOps(guard).find((o): o is Extract<Op, { kind: 'create-policy' }> => o.kind === 'create-policy')!
    expect(op.policy.name).toBe('workspaces_visibility_select')
  })

  it('auto-generates the name when nothing is declared', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .policy('app_user')
      .select((p) => p.claim('tenantId').eq(col('tenantId')))
    const op = compileToOps(guard).find((o): o is Extract<Op, { kind: 'create-policy' }> => o.kind === 'create-policy')!
    expect(op.policy.name).toBe('workspace_app_user_select')
  })

  it('throws on two policies sharing (table, declared name)', () => {
    const guard = makeGuard()
    // Two models pointing at the same physical table, both declaring the same name.
    guard
      .model('Workspace')
      .table('workspaces')
      .policy('app_user')
      .named('shared_name')
      .select((p) => p.claim('tenantId').eq(col('tenantId')))
    guard
      .model('WorkspaceAlias')
      .table('workspaces')
      .policy('app_user')
      .select((p) => p.claim('tenantId').eq(col('tenantId')), { name: 'shared_name' })
    expect(() => compileToOps(guard)).toThrow(/duplicate policy name "shared_name"/)
  })
})
