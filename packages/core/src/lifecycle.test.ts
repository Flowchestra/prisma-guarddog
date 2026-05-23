import { describe, expect, it } from 'vitest'

import { defineAppRoles } from './app-roles.js'
import { defineClaims } from './claims.js'
import { defineDbRoles } from './db-roles.js'
import { Guarddog } from './guarddog.js'
import { compileToOps, compileToState, diffStates } from './lifecycle.js'
import { applyOps, empty, type Op, type State } from './ops.js'
import { col } from './predicate.js'
import { defineResources } from './resources.js'

function makeGuard() {
  return new Guarddog({
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
    appRoles: defineAppRoles({
      'workspace.admin': {},
    }),
    resources: defineResources({
      Tenant: { model: 'Tenant', id: 'id', children: ['Workspace'] },
      Workspace: {
        model: 'Workspace',
        id: 'id',
        parent: { resource: 'Tenant', column: 'tenantId' },
      },
    }),
  })
}

function opKinds(ops: ReadonlyArray<Op>): string[] {
  return ops.map((o) => o.kind)
}

describe('compileToOps()', () => {
  it('emits create-role ops in sorted order with attributes preserved', () => {
    const guard = makeGuard()
    const ops = compileToOps(guard)
    const creates = ops.filter((o): o is Extract<Op, { kind: 'create-role' }> => o.kind === 'create-role')
    expect(creates.map((o) => o.name)).toEqual(['app_system', 'app_user'])
    const sys = creates.find((o) => o.name === 'app_system')!
    expect(sys.bypassesRls).toBe(true)
    expect(sys.nologin).toBe(true)
  })

  it('emits grant-role-membership for inherits edges', () => {
    const guard = makeGuard()
    const ops = compileToOps(guard)
    const grants = ops.filter(
      (o): o is Extract<Op, { kind: 'grant-role-membership' }> => o.kind === 'grant-role-membership'
    )
    expect(grants).toHaveLength(1)
    expect(grants[0]!.parent).toBe('app_user')
    expect(grants[0]!.child).toBe('app_system')
  })

  it('emits enable-rls + force-rls + create-policy for a policied model', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .policy('app_user')
      .select((p) => p.claim('tenantId').eq(col('tenantId')))
    const ops = compileToOps(guard)
    const kinds = opKinds(ops)
    // Order invariants: roles → memberships → enable-rls → force-rls → create-policy
    const iEnable = kinds.indexOf('enable-rls')
    const iForce = kinds.indexOf('force-rls')
    const iPolicy = kinds.indexOf('create-policy')
    const iCreateRole = kinds.indexOf('create-role')
    expect(iCreateRole).toBeLessThan(iEnable)
    expect(iEnable).toBeLessThan(iForce)
    expect(iForce).toBeLessThan(iPolicy)
    const policy = ops.find((o): o is Extract<Op, { kind: 'create-policy' }> => o.kind === 'create-policy')!
    expect(policy.policy.table).toBe('workspace')
    expect(policy.policy.dbRole).toBe('app_user')
    expect(policy.policy.verb).toBe('select')
    expect(policy.policy.name).toBe('workspace_app_user_select')
    expect(policy.policy.discriminator).toBeUndefined()
  })

  it('fuses discriminator equality into polymorphic-target policies', () => {
    const guard = makeGuard()
    guard
      .polymorphic('ScopeTarget', { discriminator: 'targetType' })
      .target('Workspace', { model: 'Workspace' })
      .policy('app_user')
      .select((p) => p.claim('tenantId').eq(col('tenantId')))

    const ops = compileToOps(guard)
    const policy = ops.find((o): o is Extract<Op, { kind: 'create-policy' }> => o.kind === 'create-policy')!
    expect(policy.policy.discriminator).toEqual({ column: 'targetType', value: 'Workspace' })
    expect(policy.policy.name).toBe('scope_target_workspace_app_user_select')

    // The `using` is an AND of the discriminator equality and the user predicate.
    const using = policy.policy.using
    expect(using?.kind).toBe('and')
    if (using?.kind !== 'and') throw new Error('unreachable')
    expect(using.operands).toHaveLength(2)
    const eq = using.operands[0]
    expect(eq?.kind).toBe('binop')
    if (eq?.kind !== 'binop') throw new Error('unreachable')
    expect(eq.op).toBe('eq')
  })

  it('emits grant-column ops for declared column privileges', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .policy('app_user')
      .select((p) => p.claim('tenantId').eq(col('tenantId')))
    guard.model('Workspace').columnPrivileges({
      apiKey: { select: ['app_system'], update: ['app_system'] },
    })
    const ops = compileToOps(guard)
    const grants = ops.filter((o): o is Extract<Op, { kind: 'grant-column' }> => o.kind === 'grant-column')
    expect(grants.map((g) => `${g.verb}:${g.column}:${g.role}`).toSorted()).toEqual([
      'select:apiKey:app_system',
      'update:apiKey:app_system',
    ])
  })

  it('is deterministic across runs', () => {
    const ops1 = compileToOps(makeGuard())
    const ops2 = compileToOps(makeGuard())
    expect(JSON.stringify(ops1)).toBe(JSON.stringify(ops2))
  })
})

describe('compileToState()', () => {
  it('round-trips through applyOps(empty(), compileToOps())', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .policy('app_user')
      .select((p) => p.claim('tenantId').eq(col('tenantId')))
    const s = compileToState(guard)
    expect(s.rlsEnabled.has('workspace')).toBe(true)
    expect(s.rlsForced.has('workspace')).toBe(true)
    expect(s.policies.size).toBe(1)
    expect(s.roles.size).toBe(2)
    expect(s.roleMemberships.size).toBe(1)
  })
})

describe('diffStates()', () => {
  it('returns empty when current === target', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .policy('app_user')
      .select((p) => p.claim('tenantId').eq(col('tenantId')))
    const s = compileToState(guard)
    expect(diffStates(s, s)).toHaveLength(0)
  })

  it('emits creates when bootstrapping from empty()', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .policy('app_user')
      .select((p) => p.claim('tenantId').eq(col('tenantId')))
    const target = compileToState(guard)
    const ops = diffStates(empty(), target)
    const kinds = opKinds(ops)
    expect(kinds).toContain('create-role')
    expect(kinds).toContain('grant-role-membership')
    expect(kinds).toContain('enable-rls')
    expect(kinds).toContain('force-rls')
    expect(kinds).toContain('create-policy')
    // Drops phase comes first; nothing to drop here, so the head is in the add phase.
    expect(kinds[0]).toBe('create-role')
  })

  it('emits drops when collapsing back to empty()', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .policy('app_user')
      .select((p) => p.claim('tenantId').eq(col('tenantId')))
    const current = compileToState(guard)
    const ops = diffStates(current, empty())
    const kinds = opKinds(ops)
    expect(kinds).toContain('drop-policy')
    expect(kinds).toContain('disable-rls')
    expect(kinds).toContain('unforce-rls')
    expect(kinds).toContain('drop-role')
    expect(kinds).toContain('revoke-role-membership')
    // Drop-policy must precede disable-rls and drop-role.
    expect(kinds.indexOf('drop-policy')).toBeLessThan(kinds.indexOf('disable-rls'))
    expect(kinds.indexOf('drop-policy')).toBeLessThan(kinds.indexOf('drop-role'))
  })

  it('treats policy content drift as drop+create', () => {
    const a = makeGuard()
    a.model('Workspace')
      .policy('app_user')
      .select((p) => p.claim('tenantId').eq(col('tenantId')))

    const b = makeGuard()
    b.model('Workspace')
      .policy('app_user')
      .select((p) => p.hasGrant('workspace.admin', col('id')))

    const ops = diffStates(compileToState(a), compileToState(b))
    const policyOps = ops.filter((o) => o.kind === 'drop-policy' || o.kind === 'create-policy')
    expect(policyOps.map((o) => o.kind)).toEqual(['drop-policy', 'create-policy'])
  })

  it('forward-replay of compile output reaches the same state as compileToState()', () => {
    const guard = makeGuard()
    guard
      .model('Workspace')
      .policy('app_user')
      .select((p) => p.claim('tenantId').eq(col('tenantId')))
    const ops = compileToOps(guard)
    const replayed: State = applyOps(empty(), ops)
    const direct = compileToState(guard)
    expect(replayed.rlsEnabled.size).toBe(direct.rlsEnabled.size)
    expect(replayed.policies.size).toBe(direct.policies.size)
    expect(replayed.roles.size).toBe(direct.roles.size)
  })
})
