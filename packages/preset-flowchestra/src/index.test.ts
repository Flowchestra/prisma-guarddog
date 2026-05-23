import { col } from '@prisma-guarddog/core'
import { describe, expect, it } from 'vitest'

import {
  createFlowchestraGuarddog,
  FLOWCHESTRA_DEFAULT_CLAIMS_ACCESSOR,
  flowchestraAppRoles,
  flowchestraClaims,
  flowchestraDbRoles,
  flowchestraResources,
} from './index.js'

describe('flowchestra preset pieces', () => {
  it('flowchestraClaims() uses the default accessor when none is provided', () => {
    const claims = flowchestraClaims()
    expect(claims.accessor).toBe(FLOWCHESTRA_DEFAULT_CLAIMS_ACCESSOR)
  })

  it('flowchestraClaims() respects a custom accessor', () => {
    const claims = flowchestraClaims({ accessor: 'custom.path' })
    expect(claims.accessor).toBe('custom.path')
  })

  it('flowchestraDbRoles() declares app_user (nologin) and app_system (bypassesRls)', () => {
    const dbRoles = flowchestraDbRoles()
    expect(dbRoles.roles.app_user.nologin).toBe(true)
    expect(dbRoles.roles.app_user.inherits).toEqual([])
    expect(dbRoles.roles.app_system.bypassesRls).toBe(true)
    expect(dbRoles.roles.app_system.inherits).toEqual(['app_user'])
  })

  it('flowchestraAppRoles() includes the canonical role vocabulary', () => {
    const appRoles = flowchestraAppRoles()
    expect(Object.keys(appRoles.roles).toSorted()).toEqual(
      [
        'tenant.admin',
        'workbench.admin',
        'workbench.editor',
        'workbench.viewer',
        'workspace.admin',
        'workspace.editor',
        'workspace.viewer',
      ].toSorted()
    )
  })

  it('flowchestraResources() declares the flat Tenant -> Workspace -> Workbench tree', () => {
    const resources = flowchestraResources()
    expect(resources.roots).toEqual(['Tenant'])
    expect(resources.resources.Workspace.parent?.resource).toBe('Tenant')
    expect(resources.resources.Workbench.parent?.resource).toBe('Workspace')
  })
})

describe('createFlowchestraGuarddog()', () => {
  it('returns a usable Guarddog with the preset primitives installed', () => {
    const guard = createFlowchestraGuarddog()
    expect(guard.config.claims.accessor).toBe(FLOWCHESTRA_DEFAULT_CLAIMS_ACCESSOR)
    expect(Object.keys(guard.config.dbRoles.roles).toSorted()).toEqual(['app_system', 'app_user'])
    expect(guard.config.resources.roots).toEqual(['Tenant'])
  })

  it('lets you author policies directly on the returned instance', () => {
    const guard = createFlowchestraGuarddog()
    guard
      .model('Workbench')
      .policy('app_user')
      .select((p) => p.claim('tenantId').eq(col('tenantId')))
    expect(guard.getPolicies()).toHaveLength(1)
  })

  it('honors the claimsAccessor override', () => {
    const guard = createFlowchestraGuarddog({ claimsAccessor: 'auth.claims' })
    expect(guard.config.claims.accessor).toBe('auth.claims')
  })
})
