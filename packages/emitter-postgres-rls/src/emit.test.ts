import { Guarddog, col, defineBusinessRoles, defineClaims, defineDbRoles, defineResources } from '@prisma-guarddog/core'
import { describe, expect, it } from 'vitest'

import { emitPolicy, emitPolymorphic, type EmitContext } from './emit.js'

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
    businessRoles: defineBusinessRoles({
      'workspace.admin': {},
      'workspace.editor': {},
    }),
    resources: defineResources({
      Workspace: { model: 'Workspace', id: 'id' },
    }),
  })
}

const ctx: EmitContext = {
  claims: defineClaims({
    accessor: 'request.jwt.claims',
    shape: (c) => ({
      sub: c.uuid(),
      tenantId: c.uuid(),
      workspaceIds: c.array(c.uuid()),
      roles: c.array(c.string()),
    }),
  }),
}

describe('emitPolicy — table prelude', () => {
  it('emits ENABLE + FORCE RLS for every policy', () => {
    const guard = makeGuard()
    guard
      .model('Workbench')
      .policy('app_user')
      .select((p) => p.literal(true))
    const sql = emitPolicy(guard.getPolicies()[0]!, ctx)
    expect(sql[0]).toBe('ALTER TABLE workbench ENABLE ROW LEVEL SECURITY;')
    expect(sql[1]).toBe('ALTER TABLE workbench FORCE ROW LEVEL SECURITY;')
  })

  it('uses the table override when provided', () => {
    const guard = makeGuard()
    guard
      .model('Workbench')
      .table('public.workbenches_v2')
      .policy('app_user')
      .select((p) => p.literal(true))
    const sql = emitPolicy(guard.getPolicies()[0]!, ctx)
    expect(sql[0]).toBe('ALTER TABLE "public.workbenches_v2" ENABLE ROW LEVEL SECURITY;')
  })

  it('uses defaultTableResolver for snake_case conversion', () => {
    const guard = makeGuard()
    guard
      .model('ScopeTarget')
      .policy('app_user')
      .select((p) => p.literal(true))
    const sql = emitPolicy(guard.getPolicies()[0]!, ctx)
    expect(sql[0]).toBe('ALTER TABLE scope_target ENABLE ROW LEVEL SECURITY;')
  })

  it('honors a custom resolveTable callback', () => {
    const guard = makeGuard()
    guard
      .model('Workbench')
      .policy('app_user')
      .select((p) => p.literal(true))
    const sql = emitPolicy(guard.getPolicies()[0]!, {
      ...ctx,
      resolveTable: () => 'custom_table',
    })
    expect(sql[0]).toBe('ALTER TABLE custom_table ENABLE ROW LEVEL SECURITY;')
  })
})

describe('emitPolicy — verbs', () => {
  it('emits DROP IF EXISTS + CREATE POLICY pair for SELECT', () => {
    const guard = makeGuard()
    guard
      .model('Workbench')
      .policy('app_user')
      .select((p) => p.claim('tenantId').eq(col('tenant_id')))
    const sql = emitPolicy(guard.getPolicies()[0]!, ctx)
    expect(sql).toContain('DROP POLICY IF EXISTS workbench_app_user_select ON workbench;')
    const createStmt = sql.find((s) => s.startsWith('CREATE POLICY workbench_app_user_select'))
    expect(createStmt).toBeDefined()
    expect(createStmt).toContain('FOR SELECT TO app_user')
    expect(createStmt).toContain('USING (')
    expect(createStmt).not.toContain('WITH CHECK')
  })

  it('emits CREATE POLICY for INSERT with WITH CHECK only', () => {
    const guard = makeGuard()
    guard
      .model('Workbench')
      .policy('app_user')
      .insert({ check: (p) => p.hasRole('workspace.editor', col('workspace_id')) })
    const sql = emitPolicy(guard.getPolicies()[0]!, ctx)
    const createStmt = sql.find((s) => s.startsWith('CREATE POLICY workbench_app_user_insert'))
    expect(createStmt).toContain('FOR INSERT TO app_user')
    expect(createStmt).toContain('WITH CHECK (')
    expect(createStmt).not.toContain('USING (')
  })

  it('emits CREATE POLICY for UPDATE with both USING and WITH CHECK', () => {
    const guard = makeGuard()
    guard
      .model('Workbench')
      .policy('app_user')
      .update({
        using: (p) => p.isOwner(col('owner_id')),
        check: (p) => p.hasRole('workspace.admin', col('workspace_id')),
      })
    const sql = emitPolicy(guard.getPolicies()[0]!, ctx)
    const createStmt = sql.find((s) => s.startsWith('CREATE POLICY workbench_app_user_update'))
    expect(createStmt).toContain('FOR UPDATE TO app_user')
    expect(createStmt).toContain('USING (')
    expect(createStmt).toContain('WITH CHECK (')
  })

  it('emits CREATE POLICY for DELETE with USING only', () => {
    const guard = makeGuard()
    guard
      .model('Workbench')
      .policy('app_user')
      .delete({ using: (p) => p.hasRole('workspace.admin', col('workspace_id')) })
    const sql = emitPolicy(guard.getPolicies()[0]!, ctx)
    const createStmt = sql.find((s) => s.startsWith('CREATE POLICY workbench_app_user_delete'))
    expect(createStmt).toContain('FOR DELETE TO app_user')
    expect(createStmt).toContain('USING (')
    expect(createStmt).not.toContain('WITH CHECK')
  })

  it('emits all four verbs when all are declared', () => {
    const guard = makeGuard()
    guard
      .model('Workbench')
      .policy('app_user')
      .select((p) => p.literal(true))
      .insert({ check: (p) => p.literal(true) })
      .update({ using: (p) => p.literal(true), check: (p) => p.literal(true) })
      .delete({ using: (p) => p.literal(true) })
    const sql = emitPolicy(guard.getPolicies()[0]!, ctx)
    expect(sql.filter((s) => s.startsWith('DROP POLICY IF EXISTS')).length).toBe(4)
    expect(sql.filter((s) => s.startsWith('CREATE POLICY')).length).toBe(4)
  })

  it('emits TODO comments before the policies', () => {
    const guard = makeGuard()
    guard
      .model('Workbench')
      .policy('app_user')
      .rawSql('select', 'tenant_id IS NOT NULL')
      .todo('Replace raw SQL with typed predicates')
    const sql = emitPolicy(guard.getPolicies()[0]!, ctx)
    expect(sql).toContain('-- TODO [workbench]: Replace raw SQL with typed predicates')
  })
})

describe('emitPolicy — predicate compilation in a real policy', () => {
  it('compiles a complex SELECT predicate to a USING clause', () => {
    const guard = makeGuard()
    guard
      .model('Workbench')
      .policy('app_user')
      .select((p) =>
        p
          .claim('tenantId')
          .eq(col('tenant_id'))
          .and(p.hasRole('workspace.admin', col('workspace_id')))
      )
    const sql = emitPolicy(guard.getPolicies()[0]!, ctx)
    const createStmt = sql.find((s) => s.startsWith('CREATE POLICY workbench_app_user_select'))!
    // Pieces in order: claim extraction, equality, AND, scoped hasRole inline.
    expect(createStmt).toContain("'tenantId'")
    expect(createStmt).toContain('tenant_id')
    expect(createStmt).toContain(' AND ')
    expect(createStmt).toContain("'roleScopes' -> 'workspace.admin'")
    expect(createStmt).not.toContain('app.has_role_on')
  })
})

describe('emitPolymorphic — discriminator equality auto-prepended', () => {
  it('emits one policy per target with the discriminator check leading', () => {
    const guard = makeGuard()
    const poly = guard.polymorphic('ScopeTarget', { discriminator: 'target_type' })
    poly
      .target('Workspace', { model: 'Workspace' })
      .policy('app_user')
      .select((p) => p.claim('tenantId').eq(col('tenant_id')))
    poly
      .target('Workbench', { model: 'Workbench' })
      .policy('app_user')
      .select((p) => p.hasRole('workbench.editor', col('target_id')))

    const sql = emitPolymorphic(guard.getPolymorphics()[0]!, ctx)
    expect(sql[0]).toBe('ALTER TABLE scope_target ENABLE ROW LEVEL SECURITY;')

    const wsCreate = sql.find((s) => s.startsWith('CREATE POLICY scope_target_workspace_app_user_select'))!
    expect(wsCreate).toContain("scope_target.target_type = 'Workspace'")
    expect(wsCreate).toContain(' AND ')
    expect(wsCreate).toContain("'tenantId'")

    const wbCreate = sql.find((s) => s.startsWith('CREATE POLICY scope_target_workbench_app_user_select'))!
    expect(wbCreate).toContain("scope_target.target_type = 'Workbench'")
    expect(wbCreate).toContain("'roleScopes' -> 'workbench.editor'")
    expect(wbCreate).not.toContain('app.has_role_on')
  })

  it('qualifies columns inside polymorphic predicates', () => {
    const guard = makeGuard()
    guard
      .polymorphic('ScopeTarget', { discriminator: 'target_type' })
      .target('Workspace', { model: 'Workspace' })
      .policy('app_user')
      .select((p) => p.isOwner(col('owner_id')))

    const sql = emitPolymorphic(guard.getPolymorphics()[0]!, ctx)
    const createStmt = sql.find((s) => s.startsWith('CREATE POLICY scope_target_workspace_app_user_select'))!
    expect(createStmt).toContain('scope_target.owner_id =')
  })

  it('emits both USING and WITH CHECK for UPDATE with discriminator on both', () => {
    const guard = makeGuard()
    guard
      .polymorphic('ScopeTarget', { discriminator: 'target_type' })
      .target('Workspace', { model: 'Workspace' })
      .policy('app_user')
      .update({
        using: (p) => p.literal(true),
        check: (p) => p.literal(true),
      })

    const sql = emitPolymorphic(guard.getPolymorphics()[0]!, ctx)
    const createStmt = sql.find((s) => s.startsWith('CREATE POLICY scope_target_workspace_app_user_update'))!
    // Discriminator equality appears twice (once for USING, once for CHECK).
    const occurrences = createStmt.match(/scope_target\.target_type = 'Workspace'/g)!.length
    expect(occurrences).toBe(2)
  })
})

describe('emitPolicy — return value is frozen', () => {
  it('returns a frozen readonly array', () => {
    const guard = makeGuard()
    guard
      .model('Workbench')
      .policy('app_user')
      .select((p) => p.literal(true))
    const sql = emitPolicy(guard.getPolicies()[0]!, ctx)
    expect(Object.isFrozen(sql)).toBe(true)
  })
})
