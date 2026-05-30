import {
  col,
  compileToState,
  defineAppRoles,
  defineClaims,
  defineDbRoles,
  defineResources,
  Guarddog,
} from '@flowchestra/prisma-guarddog-core'
import type { ImportedPolicyRow, PolicyInventoryRow } from '@flowchestra/prisma-guarddog-importer-postgres'
import { describe, expect, it } from 'vitest'

import { type AdoptionDisposition, computePolicyDrift, driftToDropOps, planAdoption } from './drift.js'
import { GUARDDOG_IGNORE_COMMENT, GUARDDOG_POLICY_COMMENT } from './render-ops.js'

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

  it('flags a permissive ↔ restrictive disagreement on a declared+owned policy (ADR-0032)', () => {
    const guard = new Guarddog({
      claims: defineClaims({ accessor: 'request.jwt.claims', shape: (c) => ({ sub: c.uuid(), tenantId: c.uuid() }) }),
      dbRoles: defineDbRoles({ app_user: { inherits: [], nologin: true } }),
      appRoles: defineAppRoles({}),
      resources: defineResources({}),
    })
    // Declared restrictive isolation floor.
    guard.model('Workspace').isolation((p) => p.claim('tenantId').eq(col('tenantId')))
    const declared = compileToState(guard)
    const live: PolicyInventoryRow[] = [
      // Live still shows the policy as permissive — drift.
      row({
        table: 'workspace',
        policyName: 'workspace_isolation',
        comment: GUARDDOG_POLICY_COMMENT,
        command: 'ALL',
        permissive: true,
      }),
    ]
    const drift = computePolicyDrift(declared, live)
    expect(drift.restrictivenessMismatch).toHaveLength(1)
    const m = drift.restrictivenessMismatch[0]!
    expect(m.table).toBe('workspace')
    expect(m.policyName).toBe('workspace_isolation')
    expect(m.declaredRestrictive).toBe(true)
    expect(m.livePermissive).toBe(true)
    expect(drift.ok).toBe(false)
  })

  it('reports ok when declared restrictive matches live restrictive', () => {
    const guard = new Guarddog({
      claims: defineClaims({ accessor: 'request.jwt.claims', shape: (c) => ({ sub: c.uuid(), tenantId: c.uuid() }) }),
      dbRoles: defineDbRoles({ app_user: { inherits: [], nologin: true } }),
      appRoles: defineAppRoles({}),
      resources: defineResources({}),
    })
    guard.model('Workspace').isolation((p) => p.claim('tenantId').eq(col('tenantId')))
    const declared = compileToState(guard)
    const live: PolicyInventoryRow[] = [
      row({
        table: 'workspace',
        policyName: 'workspace_isolation',
        comment: GUARDDOG_POLICY_COMMENT,
        command: 'ALL',
        permissive: false, // restrictive in pg_policies
      }),
    ]
    const drift = computePolicyDrift(declared, live)
    expect(drift.restrictivenessMismatch).toHaveLength(0)
    expect(drift.ok).toBe(true)
  })

  it('treats an :ignore-marked foreign policy as acknowledged (not foreign), keeping ok', () => {
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
      // a foreign policy the operator deliberately kept (adopt → keep)
      row({ table: 'workspace', policyName: 'kept_legacy', comment: GUARDDOG_IGNORE_COMMENT, command: 'ALL' }),
    ]
    const drift = computePolicyDrift(declared, live)
    expect(drift.acknowledged.map((a) => a.policyName)).toEqual(['kept_legacy'])
    expect(drift.foreign).toHaveLength(0)
    expect(drift.ok).toBe(true)
  })
})

const importedRow = (
  over: Partial<ImportedPolicyRow> & Pick<ImportedPolicyRow, 'table' | 'policyName'>
): ImportedPolicyRow =>
  Object.freeze({
    schema: 'public',
    command: 'ALL',
    roles: Object.freeze(['app_user']),
    usingExpression: 'true',
    withCheckExpression: null,
    permissive: true,
    ...over,
  })

describe('planAdoption', () => {
  const foreign = [
    { table: 'workspace', policyName: 'p_keep', command: 'ALL', permissive: true },
    { table: 'workspace', policyName: 'p_remove', command: 'ALL', permissive: true },
    { table: 'workspace', policyName: 'p_edit', command: 'SELECT', permissive: true },
    { table: 'workspace', policyName: 'p_override', command: 'UPDATE', permissive: true },
    { table: 'workspace', policyName: 'p_skip', command: 'DELETE', permissive: true },
  ] as const
  const rowsByKey = new Map([
    ['workspace::p_edit', importedRow({ table: 'workspace', policyName: 'p_edit', usingExpression: 'tenant_id = x' })],
  ])
  const dispositions = new Map<string, AdoptionDisposition>([
    ['workspace::p_keep', 'keep'],
    ['workspace::p_remove', 'remove'],
    ['workspace::p_edit', 'edit'],
    ['workspace::p_override', 'override'],
    ['workspace::p_skip', 'skip'],
  ])

  it('routes each disposition to its effect', () => {
    const plan = planAdoption(foreign, rowsByKey, dispositions)
    expect(plan.keep.map((k) => k.policyName)).toEqual(['p_keep'])
    expect(plan.dropOps).toEqual([{ kind: 'drop-policy', table: 'workspace', name: 'p_remove' }])
    expect(plan.editRows.map((r) => r.policyName)).toEqual(['p_edit'])
    expect(plan.overrides.map((o) => o.policyName)).toEqual(['p_override'])
    expect(plan.skipped.map((s) => s.policyName)).toEqual(['p_skip'])
  })

  it('defaults a missing disposition to skip, and an edit with no source row to skip', () => {
    const plan = planAdoption(
      [
        { table: 'workspace', policyName: 'no_decision', command: 'ALL', permissive: true },
        { table: 'workspace', policyName: 'edit_no_row', command: 'ALL', permissive: true },
      ],
      new Map(),
      new Map([['workspace::edit_no_row', 'edit']])
    )
    expect(plan.skipped.map((s) => s.policyName).toSorted()).toEqual(['edit_no_row', 'no_decision'])
    expect(plan.editRows).toHaveLength(0)
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
