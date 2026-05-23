import {
  compileToOps,
  defineAppRoles,
  defineClaims,
  defineDbRoles,
  defineResources,
  Guarddog,
  type Op,
} from '@prisma-guarddog/core'
import { col } from '@prisma-guarddog/core'
import { describe, expect, it } from 'vitest'

import { renderOps } from './render-ops.js'

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
      app_system: { inherits: ['app_user'], bypassesRls: true, nologin: true },
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

function render(ops: readonly Op[]): readonly string[] {
  const guard = makeGuard()
  return renderOps(ops, { claims: guard.config.claims })
}

describe('renderOps()', () => {
  it('returns an empty array for an empty op list', () => {
    expect(render([])).toEqual([])
  })

  it('renders enable / disable RLS as ALTER TABLE', () => {
    const sql = render([
      { kind: 'enable-rls', table: 'workspace' },
      { kind: 'disable-rls', table: 'workspace' },
      { kind: 'force-rls', table: 'workspace' },
      { kind: 'unforce-rls', table: 'workspace' },
    ])
    expect(sql[0]).toContain('ENABLE ROW LEVEL SECURITY')
    expect(sql[1]).toContain('DISABLE ROW LEVEL SECURITY')
    expect(sql[2]).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql[3]).toContain('NO FORCE ROW LEVEL SECURITY')
  })

  it('renders create-policy as drop+create with compiled USING clause', () => {
    const guard = makeGuard()
    const ops = compileToOps(guard)
    const sql = renderOps(ops, { claims: guard.config.claims })
    const createPolicySql = sql.find((s) => s.startsWith('CREATE POLICY'))!
    expect(createPolicySql).toMatch(/CREATE POLICY workspace_app_user_select ON workspace/)
    expect(createPolicySql).toMatch(/FOR SELECT TO app_user/)
    expect(createPolicySql).toMatch(/USING \(/)
    const dropSql = sql.find((s) => s.startsWith('DROP POLICY'))!
    expect(dropSql).toMatch(/DROP POLICY IF EXISTS workspace_app_user_select/)
  })

  it('renders column GRANT and REVOKE (camelCase columns get quoted)', () => {
    const sql = render([
      { kind: 'grant-column', table: 'workspace', column: 'apiKey', verb: 'select', role: 'app_system' },
      { kind: 'revoke-column', table: 'workspace', column: 'apiKey', verb: 'select', role: 'app_system' },
    ])
    expect(sql[0]).toBe('GRANT SELECT ("apiKey") ON workspace TO app_system;')
    expect(sql[1]).toBe('REVOKE SELECT ("apiKey") ON workspace FROM app_system;')
  })

  it('wraps create-role / drop-role / grants in idempotent DO blocks', () => {
    const sql = render([
      { kind: 'create-role', name: 'app_user', bypassesRls: false, nologin: true },
      { kind: 'drop-role', name: 'app_user' },
      { kind: 'grant-role-membership', parent: 'app_user', child: 'app_system' },
      { kind: 'revoke-role-membership', parent: 'app_user', child: 'app_system' },
    ])
    expect(sql[0]).toContain('CREATE ROLE app_user INHERIT NOLOGIN')
    expect(sql[0]).toContain('pg_roles')
    expect(sql[1]).toContain('DROP ROLE app_user')
    expect(sql[2]).toContain('GRANT app_user TO app_system')
    expect(sql[3]).toContain('REVOKE app_user FROM app_system')
  })
})
