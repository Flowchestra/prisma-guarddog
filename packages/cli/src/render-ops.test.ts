import {
  compileToOps,
  defineAppRoles,
  defineClaims,
  defineDbRoles,
  defineResources,
  Guarddog,
  type Op,
} from '@flowchestra/prisma-guarddog-core'
import { col } from '@flowchestra/prisma-guarddog-core'
import { describe, expect, it } from 'vitest'

import { GUARDDOG_POLICY_COMMENT, renderOps } from './render-ops.js'

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

  it('stamps every created policy with the guarddog ownership comment (ADR-0029)', () => {
    const guard = makeGuard()
    const sql = renderOps(compileToOps(guard), { claims: guard.config.claims })
    const comment = sql.find((s) => s.startsWith('COMMENT ON POLICY'))!
    expect(comment).toBe(`COMMENT ON POLICY workspace_app_user_select ON workspace IS '${GUARDDOG_POLICY_COMMENT}';`)
    // one comment per created policy
    const creates = sql.filter((s) => s.startsWith('CREATE POLICY')).length
    const comments = sql.filter((s) => s.startsWith('COMMENT ON POLICY')).length
    expect(comments).toBe(creates)
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

  it('renders create-schema as CREATE SCHEMA IF NOT EXISTS', () => {
    // safe lowercase identifiers are emitted bare (quoteIdent only quotes when needed)
    expect(render([{ kind: 'create-schema', schema: 'app' }])[0]).toBe('CREATE SCHEMA IF NOT EXISTS app;')
  })

  it('renders create-function as CREATE OR REPLACE FUNCTION with attributes and dollar-quoted body', () => {
    const sql = render([
      {
        kind: 'create-function',
        fn: {
          schema: 'app',
          name: 'user_has_grant',
          args: [
            { name: 'resource_id', type: 'text', default: undefined },
            { name: 'min_role', type: 'text', default: 'NULL' },
          ],
          returns: 'boolean',
          language: 'sql',
          volatility: 'stable',
          parallel: 'safe',
          security: 'definer',
          searchPath: ['pg_catalog', 'public'],
          body: 'SELECT true',
          signature: 'app.user_has_grant(resource_id text, min_role text) -> boolean',
        },
      },
    ])[0]!
    expect(sql).toContain('CREATE OR REPLACE FUNCTION app.user_has_grant(resource_id text, min_role text DEFAULT NULL)')
    expect(sql).toContain('RETURNS boolean')
    expect(sql).toContain('LANGUAGE sql')
    expect(sql).toContain('STABLE')
    expect(sql).toContain('PARALLEL SAFE')
    expect(sql).toContain('SECURITY DEFINER')
    expect(sql).toContain('SET search_path TO pg_catalog, public')
    expect(sql).toContain('AS $guarddog$\nSELECT true\n$guarddog$;')
  })

  it('picks a collision-free dollar-quote tag', () => {
    const sql = render([
      {
        kind: 'create-function',
        fn: {
          schema: 'app',
          name: 'f',
          args: [],
          returns: 'text',
          language: 'sql',
          volatility: 'volatile',
          parallel: 'unsafe',
          security: 'invoker',
          searchPath: [],
          body: "SELECT '$guarddog$'",
          signature: 'app.f() -> text',
        },
      },
    ])[0]!
    expect(sql).toContain('AS $guarddog1$')
    expect(sql).not.toMatch(/AS \$guarddog\$/)
  })

  it('renders drop-function / grant-execute / revoke-execute with full signatures', () => {
    const sql = render([
      { kind: 'drop-function', schema: 'app', name: 'f', argTypes: ['text', 'integer'] },
      { kind: 'grant-execute', schema: 'app', name: 'f', role: 'app_user', argTypes: ['text', 'integer'] },
      { kind: 'revoke-execute', schema: 'app', name: 'f', role: 'app_user', argTypes: ['text', 'integer'] },
    ])
    expect(sql[0]).toBe('DROP FUNCTION IF EXISTS app.f(text, integer);')
    // grant-execute is preceded by a one-time schema USAGE grant
    expect(sql[1]).toBe('GRANT USAGE ON SCHEMA app TO app_user;')
    expect(sql[2]).toBe('GRANT EXECUTE ON FUNCTION app.f(text, integer) TO app_user;')
    expect(sql[3]).toBe('REVOKE EXECUTE ON FUNCTION app.f(text, integer) FROM app_user;')
  })

  it('emits the schema USAGE grant once per (schema, role) across multiple functions', () => {
    const sql = render([
      { kind: 'grant-execute', schema: 'app', name: 'f', role: 'app_user', argTypes: ['text'] },
      { kind: 'grant-execute', schema: 'app', name: 'g', role: 'app_user', argTypes: ['text'] },
      { kind: 'grant-execute', schema: 'app', name: 'g', role: 'app_system', argTypes: ['text'] },
    ])
    expect(sql.filter((s) => s === 'GRANT USAGE ON SCHEMA app TO app_user;')).toHaveLength(1)
    expect(sql.filter((s) => s === 'GRANT USAGE ON SCHEMA app TO app_system;')).toHaveLength(1)
    expect(sql.filter((s) => s.startsWith('GRANT EXECUTE'))).toHaveLength(3)
  })

  it('compiles p.fn() inside a policy when functionSchema is supplied', () => {
    const guard = new Guarddog({
      claims: defineClaims({ accessor: 'request.jwt.claims', shape: (c) => ({ sub: c.uuid() }) }),
      dbRoles: defineDbRoles({ app_user: { inherits: [], nologin: true } }),
      appRoles: defineAppRoles({}),
      resources: defineResources({}),
    })
    guard
      .model('Doc')
      .policy('app_user')
      .select((p) => p.fn('user_has_grant', col('id'), p.claim('sub')))
    const ops = compileToOps(guard)
    const sql = renderOps(ops, { claims: guard.config.claims, functionSchema: 'app' })
    const createPolicy = sql.find((s) => s.startsWith('CREATE POLICY'))!
    expect(createPolicy).toContain('USING (app.user_has_grant(id,')
    expect(createPolicy).toContain("'sub'))::uuid")
  })

  it('renders restrictive policies with `AS RESTRICTIVE FOR ALL` (ADR-0032)', () => {
    const guard = makeGuard()
    guard.model('Workspace').isolation((p) => p.claim('tenantId').eq(col('tenantId')))
    const sql = renderOps(compileToOps(guard), { claims: guard.config.claims })
    const restrictive = sql.find((s) => s.includes('workspace_isolation') && s.startsWith('CREATE POLICY'))!
    expect(restrictive).toMatch(
      /CREATE POLICY workspace_isolation ON workspace AS RESTRICTIVE FOR ALL TO public USING \(.+\) WITH CHECK \(.+\);/
    )
    // The permissive policy on the same model stays permissive (no AS clause).
    const permissive = sql.find((s) => s.includes('workspace_app_user_select') && s.startsWith('CREATE POLICY'))!
    expect(permissive).not.toMatch(/AS RESTRICTIVE/)
    expect(permissive).not.toMatch(/AS PERMISSIVE/)
  })
})
