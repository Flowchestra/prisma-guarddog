import {
  defineAppRoles,
  defineClaims,
  defineDbRoles,
  defineResources,
  Guarddog,
  col,
} from '@flowchestra/prisma-guarddog-core'
import { describe, expect, it } from 'vitest'

import { lintCoverage } from './coverage.js'

function makeGuard() {
  return new Guarddog({
    claims: defineClaims({
      accessor: 'request.jwt.claims',
      shape: (c) => ({ sub: c.uuid(), tenantId: c.uuid() }),
    }),
    dbRoles: defineDbRoles({ app_user: { inherits: [] } }),
    appRoles: defineAppRoles({}),
    resources: defineResources({
      Tenant: { model: 'Tenant', id: 'id' },
    }),
  })
}

describe('lintCoverage()', () => {
  it('reports missing-coverage when a Prisma model has no declaration', () => {
    const guard = makeGuard()
    const report = lintCoverage({
      guard,
      prismaModels: [{ name: 'Workspace' }],
    })
    expect(report.ok).toBe(false)
    expect(report.issues).toHaveLength(1)
    expect(report.issues[0]!.kind).toBe('missing-coverage')
    expect(report.issues[0]!.modelName).toBe('Workspace')
    expect(report.issues[0]!.severity).toBe('error')
  })

  it('treats a model with a .policy() as covered', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .policy('app_user')
      .select((p) => p.claim('tenantId').eq(col('tenantId')))
    const report = lintCoverage({ guard, prismaModels: [{ name: 'Workspace' }] })
    expect(report.ok).toBe(true)
  })

  it('treats a model with .noPolicy() as covered', () => {
    const guard = makeGuard()
    guard.noPolicy('MigrationLedger', { reason: 'system-only table' })
    const report = lintCoverage({ guard, prismaModels: [{ name: 'MigrationLedger' }] })
    expect(report.ok).toBe(true)
  })

  it('treats polymorphic model + targets as covered', () => {
    const guard = makeGuard()
    guard
      .polymorphic('ScopeTarget', { discriminator: 'targetType' })
      .target('Workspace', { model: 'Workspace' })
      .policy('app_user')
      .select((p) => p.literal(true))
    const report = lintCoverage({
      guard,
      prismaModels: [{ name: 'ScopeTarget' }, { name: 'Workspace' }],
    })
    expect(report.ok).toBe(true)
  })

  it('flags todo() markers as warnings (does not fail ok)', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .policy('app_user')
      .select((p) => p.literal(true))
      .todo('replace literal with tenant scoping')
    const report = lintCoverage({ guard, prismaModels: [{ name: 'Workspace' }] })
    expect(report.ok).toBe(true)
    const warning = report.issues.find((i) => i.kind === 'todo-marker')
    expect(warning).toBeDefined()
    expect(warning?.detail).toContain('replace literal with tenant scoping')
  })

  it('flags rawSql() policies as warnings', () => {
    const guard = makeGuard()
    guard.model('Workspace').policy('app_user').rawSql('select', 'tenant_id = current_setting(...)::uuid')
    const report = lintCoverage({ guard, prismaModels: [{ name: 'Workspace' }] })
    expect(report.ok).toBe(true)
    expect(report.issues.some((i) => i.kind === 'raw-sql-policy')).toBe(true)
  })

  it('returns deterministic ordering by (model, severity, kind)', () => {
    const guard = makeGuard()
    guard.model('B').policy('app_user').rawSql('select', 'true')
    guard
      .model('A')
      .policy('app_user')
      .select((p) => p.literal(true))
      .todo('todo on A')
    const report = lintCoverage({ guard, prismaModels: [{ name: 'A' }, { name: 'B' }] })
    const names = report.issues.map((i) => i.modelName)
    expect(names).toEqual([...names].toSorted())
  })
})
