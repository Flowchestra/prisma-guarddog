import {
  col,
  compileToState,
  defineAppRoles,
  defineClaims,
  defineDbRoles,
  defineResources,
  Guarddog,
} from '@flowchestra/prisma-guarddog-core'
import type { PolicyInventoryRow } from '@flowchestra/prisma-guarddog-importer-postgres'
import { describe, expect, it } from 'vitest'

import { computePolicyDrift, driftToDropOps } from './drift.js'
import { GUARDDOG_POLICY_COMMENT } from './render-ops.js'

function declaredState() {
  const guard = new Guarddog({
    claims: defineClaims({ accessor: 'request.jwt.claims', shape: (c) => ({ sub: c.uuid(), tenantId: c.uuid() }) }),
    dbRoles: defineDbRoles({ app_user: { inherits: [], nologin: true } }),
    appRoles: defineAppRoles({}),
    resources: defineResources({}),
  })
  // declares workspace_app_user_select + workspace_app_user_insert on table `workspace`
  guard
    .model('Workspace')
    .policy('app_user')
    .select((p) => p.claim('tenantId').eq(col('tenantId')))
    .insert({ check: (p) => p.claim('tenantId').eq(col('tenantId')) })
  return compileToState(guard)
}

const row = (
  over: Partial<PolicyInventoryRow> & Pick<PolicyInventoryRow, 'table' | 'policyName'>
): PolicyInventoryRow =>
  Object.freeze({
    schema: 'public',
    command: 'ALL',
    permissive: true,
    comment: null,
    ...over,
  })

describe('computePolicyDrift', () => {
  it('classifies foreign, stale-managed, missing, and ignores unmanaged tables', () => {
    const declared = declaredState()
    const live: PolicyInventoryRow[] = [
      // declared + guarddog-owned → in sync
      row({
        table: 'workspace',
        policyName: 'workspace_app_user_select',
        comment: GUARDDOG_POLICY_COMMENT,
        command: 'SELECT',
        permissive: true,
      }),
      // a consumer's legacy FOR ALL policy on a managed table → foreign + permissive (widener)
      row({
        table: 'workspace',
        policyName: 'workspaces_manager_write',
        command: 'ALL',
        permissive: true,
        comment: null,
      }),
      // guarddog-marked but no longer declared → stale-managed
      row({
        table: 'workspace',
        policyName: 'workspace_app_user_delete',
        comment: GUARDDOG_POLICY_COMMENT,
        command: 'DELETE',
      }),
      // on a table guarddog does NOT manage → ignored entirely
      row({ table: 'unrelated_table', policyName: 'whatever', comment: null }),
    ]

    const drift = computePolicyDrift(declared, live)

    expect(drift.managedTables).toEqual(['workspace'])
    expect(drift.foreign.map((f) => f.policyName)).toEqual(['workspaces_manager_write'])
    expect(drift.foreign[0]!.permissive).toBe(true)
    expect(drift.staleManaged.map((s) => s.policyName)).toEqual(['workspace_app_user_delete'])
    // declared insert policy is absent from `live` → missing
    expect(drift.missing.map((m) => m.policyName)).toContain('workspace_app_user_insert')
    expect(drift.ok).toBe(false)
  })

  it('reports ok when the live DB exactly matches the declared, owned policies', () => {
    const declared = declaredState()
    const live: PolicyInventoryRow[] = [
      row({
        table: 'workspace',
        policyName: 'workspace_app_user_select',
        comment: GUARDDOG_POLICY_COMMENT,
        command: 'SELECT',
      }),
      row({
        table: 'workspace',
        policyName: 'workspace_app_user_insert',
        comment: GUARDDOG_POLICY_COMMENT,
        command: 'INSERT',
      }),
    ]
    const drift = computePolicyDrift(declared, live)
    expect(drift.ok).toBe(true)
    expect(drift.foreign).toHaveLength(0)
    expect(drift.staleManaged).toHaveLength(0)
    expect(drift.missing).toHaveLength(0)
  })

  it('does not flag foreign policies on tables guarddog does not manage', () => {
    const declared = declaredState()
    const live: PolicyInventoryRow[] = [row({ table: 'audit_logs', policyName: 'legacy_audit', comment: null })]
    const drift = computePolicyDrift(declared, live)
    expect(drift.foreign).toHaveLength(0)
  })
})

describe('driftToDropOps', () => {
  it('emits drop-policy for foreign + stale-managed, not for declared/owned', () => {
    const declared = declaredState()
    const live: PolicyInventoryRow[] = [
      row({
        table: 'workspace',
        policyName: 'workspace_app_user_select',
        comment: GUARDDOG_POLICY_COMMENT,
        command: 'SELECT',
      }),
      row({ table: 'workspace', policyName: 'workspaces_manager_write', command: 'ALL', comment: null }),
      row({ table: 'workspace', policyName: 'orphan_guarddog', comment: GUARDDOG_POLICY_COMMENT }),
    ]
    const ops = driftToDropOps(computePolicyDrift(declared, live))
    const dropped = ops.map((o) => (o.kind === 'drop-policy' ? o.name : '')).filter(Boolean)
    expect(dropped).toEqual(['orphan_guarddog', 'workspaces_manager_write'])
    expect(ops.every((o) => o.kind === 'drop-policy')).toBe(true)
  })
})
