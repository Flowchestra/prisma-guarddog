import {
  compileToState,
  defineAppRoles,
  defineClaims,
  defineDbRoles,
  defineResources,
  empty,
  Guarddog,
} from '@flowchestra/prisma-guarddog-core'
import { col } from '@flowchestra/prisma-guarddog-core'
import { describe, expect, it } from 'vitest'

import { planMigrate } from './migrate.js'

function makeGuard() {
  const guard = new Guarddog({
    claims: defineClaims({
      accessor: 'request.jwt.claims',
      shape: (c) => ({
        sub: c.uuid(),
        tenantId: c.uuid(),
      }),
    }),
    dbRoles: defineDbRoles({
      app_user: { inherits: [], nologin: true },
    }),
    appRoles: defineAppRoles({ 'workspace.admin': {} }),
    resources: defineResources({
      Tenant: { model: 'Tenant', id: 'id' },
    }),
  })
  guard
    .model('Workspace')
    .policy('app_user')
    .select((p) => p.claim('tenantId').eq(col('tenantId')))
  return guard
}

describe('planMigrate()', () => {
  it('produces a non-empty op list and rendered SQL when starting from empty()', () => {
    const guard = makeGuard()
    const plan = planMigrate(guard, empty())
    expect(plan.ops.length).toBeGreaterThan(0)
    // Each create-policy op renders as both a DROP and a CREATE statement,
    // so sql.length >= ops.length rather than equal.
    expect(plan.sql.length).toBeGreaterThanOrEqual(plan.ops.length)
    expect(plan.sql.some((s) => s.includes('CREATE POLICY'))).toBe(true)
    expect(plan.sql.some((s) => s.includes('ENABLE ROW LEVEL SECURITY'))).toBe(true)
  })

  it('returns an empty plan when current state already matches the schema', () => {
    const guard = makeGuard()
    const target = compileToState(guard)
    const plan = planMigrate(guard, target)
    expect(plan.ops).toHaveLength(0)
    expect(plan.sql).toHaveLength(0)
  })

  it('exposes current and target State on the plan', () => {
    const guard = makeGuard()
    const plan = planMigrate(guard, empty())
    expect(plan.current.policies.size).toBe(0)
    expect(plan.target.policies.size).toBe(1)
  })
})
