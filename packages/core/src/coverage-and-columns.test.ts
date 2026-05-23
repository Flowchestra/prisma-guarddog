import { describe, expect, it } from 'vitest'

import type { NoPolicyAst, PolicyAst } from './ast.js'
import { defineBusinessRoles } from './business-roles.js'
import { defineClaims } from './claims.js'
import { defineDbRoles } from './db-roles.js'
import { Guarddog } from './guarddog.js'
import { defineResources } from './resources.js'

function makeGuard() {
  return new Guarddog({
    claims: defineClaims({
      accessor: 'request.jwt.claims',
      shape: (c) => ({ sub: c.uuid(), tenantId: c.uuid() }),
    }),
    dbRoles: defineDbRoles({
      app_user: { inherits: [] },
      app_system: { inherits: ['app_user'], bypassesRls: true },
      app_admin: { inherits: ['app_system'] },
    }),
    businessRoles: defineBusinessRoles({ 'workspace.admin': {} }),
    resources: defineResources({
      Workspace: { model: 'Workspace', id: 'id' },
    }),
  })
}

describe('Guarddog.noPolicy', () => {
  it('registers a NoPolicyAst with the supplied reason', () => {
    const guard = makeGuard()
    guard.noPolicy('MigrationLedger', { reason: 'system-only table' })
    const nps = guard.getNoPolicies()
    expect(nps).toHaveLength(1)
    expect(nps[0]).toEqual<NoPolicyAst>({ model: 'MigrationLedger', reason: 'system-only table' })
  })

  it('rejects an empty reason (the whole point is auditability)', () => {
    const guard = makeGuard()
    expect(() => guard.noPolicy('X', { reason: '' })).toThrow(/reason must be a non-empty string/)
  })

  it('rejects an empty model name', () => {
    const guard = makeGuard()
    expect(() => guard.noPolicy('', { reason: 'x' })).toThrow(/modelName must be a non-empty string/)
  })

  it('rejects noPolicy on a model that already has builder activity', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .policy('app_user')
      .select((p) => p.literal(true))
    expect(() => guard.noPolicy('Workspace', { reason: 'x' })).toThrow(
      /cannot mark a model as noPolicy after it has had any builder activity/
    )
  })

  it('rejects model() on a model previously declared as noPolicy', () => {
    const guard = makeGuard()
    guard.noPolicy('Workspace', { reason: 'system-only' })
    expect(() => guard.model('Workspace')).toThrow(/previously declared as noPolicy/)
  })

  it('freezes the NoPolicyAst', () => {
    const guard = makeGuard()
    guard.noPolicy('X', { reason: 'r' })
    expect(Object.isFrozen(guard.getNoPolicies()[0])).toBe(true)
    expect(Object.isFrozen(guard.getNoPolicies())).toBe(true)
  })
})

describe('ModelBuilder.columnPrivileges', () => {
  it('produces a ColumnPrivilegeAst keyed by model', () => {
    const guard = makeGuard()
    guard.model('Workspace').columnPrivileges({
      apiKey: { select: ['app_system'], update: ['app_system'] },
      internalNotes: { select: ['app_system', 'app_admin'] },
    })
    const cps = guard.getColumnPrivileges()
    expect(cps).toHaveLength(1)
    expect(cps[0]?.model).toBe('Workspace')
    expect(cps[0]?.columns.apiKey).toEqual({
      select: ['app_system'],
      insert: [],
      update: ['app_system'],
    })
    expect(cps[0]?.columns.internalNotes).toEqual({
      select: ['app_system', 'app_admin'],
      insert: [],
      update: [],
    })
  })

  it('merges repeated calls for the same model (union per verb per column)', () => {
    const guard = makeGuard()
    const m = guard.model('Workspace')
    m.columnPrivileges({ apiKey: { select: ['app_system'] } })
    m.columnPrivileges({ apiKey: { select: ['app_admin'], update: ['app_system'] } })
    const cps = guard.getColumnPrivileges()
    expect(cps[0]?.columns.apiKey).toEqual({
      select: ['app_system', 'app_admin'],
      insert: [],
      update: ['app_system'],
    })
  })

  it('rejects an empty column name', () => {
    const guard = makeGuard()
    expect(() => guard.model('Workspace').columnPrivileges({ '': { select: ['app_system'] } })).toThrow(
      /column name must be a non-empty string/
    )
  })

  it('omits models with no column-privilege rules from the AST list', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .policy('app_user')
      .select((p) => p.literal(true))
    expect(guard.getColumnPrivileges()).toHaveLength(0)
  })

  it('returned ColumnPrivilegeAst is frozen', () => {
    const guard = makeGuard()
    guard.model('Workspace').columnPrivileges({ apiKey: { select: ['app_system'] } })
    const cps = guard.getColumnPrivileges()
    expect(Object.isFrozen(cps)).toBe(true)
    expect(Object.isFrozen(cps[0])).toBe(true)
    expect(Object.isFrozen(cps[0]?.columns)).toBe(true)
  })

  it('table() override propagates to the ColumnPrivilegeAst', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .table('public.workspaces_v2')
      .columnPrivileges({ apiKey: { select: ['app_system'] } })
    expect(guard.getColumnPrivileges()[0]?.table).toBe('public.workspaces_v2')
  })
})

describe('PolicyBuilder.rawSql', () => {
  it.each(['select', 'insert', 'delete'] as const)('wraps %s as a raw Expr', (verb) => {
    const guard = makeGuard()
    guard.model('Workspace').policy('app_user').rawSql(verb, 'tenant_id IS NOT NULL')

    const policy = guard.getPolicies()[0] as PolicyAst
    const spec = policy[verb]
    expect(spec).toBeDefined()
    // `select` / `delete` have `using`; `insert` has `check`. Read via a switch.
    const expr =
      verb === 'select' ? policy.select?.using : verb === 'insert' ? policy.insert?.check : policy.delete?.using
    expect(expr).toEqual({ kind: 'raw', sql: 'tenant_id IS NOT NULL' })
  })

  it('wraps update as raw for both USING and WITH CHECK', () => {
    const guard = makeGuard()
    guard.model('Workspace').policy('app_user').rawSql('update', 'tenant_id IS NOT NULL')
    const policy = guard.getPolicies()[0] as PolicyAst
    expect(policy.update?.using).toEqual({ kind: 'raw', sql: 'tenant_id IS NOT NULL' })
    expect(policy.update?.check).toEqual({ kind: 'raw', sql: 'tenant_id IS NOT NULL' })
  })

  it('rejects empty SQL', () => {
    const guard = makeGuard()
    expect(() => guard.model('Workspace').policy('app_user').rawSql('select', '')).toThrow(
      /sql must be a non-empty string/
    )
  })
})

describe('PolicyBuilder.todo', () => {
  it('appends TODO markers to the PolicyAst', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .policy('app_user')
      .rawSql('select', 'x = y')
      .todo('Replace raw SQL with typed predicates')
      .todo('Audit role coverage with security team')

    const policy = guard.getPolicies()[0] as PolicyAst
    expect(policy.todos).toEqual(['Replace raw SQL with typed predicates', 'Audit role coverage with security team'])
    expect(Object.isFrozen(policy.todos)).toBe(true)
  })

  it('defaults to empty todos array', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .policy('app_user')
      .select((p) => p.literal(true))
    expect(guard.getPolicies()[0]?.todos).toEqual([])
  })

  it('rejects empty message', () => {
    const guard = makeGuard()
    expect(() =>
      guard
        .model('Workspace')
        .policy('app_user')
        .select((p) => p.literal(true))
        .todo('')
    ).toThrow(/message must be a non-empty string/)
  })
})
