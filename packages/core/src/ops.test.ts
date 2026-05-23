import { describe, expect, it } from 'vitest'

import type { Expr } from './ast.js'
import { applyOps, columnGrantKey, empty, type Op, policyMapKey, roleMembershipKey, type State } from './ops.js'

const litTrue: Expr = Object.freeze({ kind: 'literal', value: true })

function policyOp(table: string, name: string, dbRole = 'app_user'): Op {
  return {
    kind: 'create-policy',
    policy: Object.freeze({
      name,
      model: table,
      table,
      dbRole,
      verb: 'select',
      using: litTrue,
      check: undefined,
      todos: Object.freeze([]),
      discriminator: undefined,
    }),
  }
}

describe('empty()', () => {
  it('returns an empty, frozen state', () => {
    const s = empty()
    expect(s.rlsEnabled.size).toBe(0)
    expect(s.rlsForced.size).toBe(0)
    expect(s.policies.size).toBe(0)
    expect(s.columnGrants.size).toBe(0)
    expect(s.roles.size).toBe(0)
    expect(s.roleMemberships.size).toBe(0)
    expect(Object.isFrozen(s)).toBe(true)
  })
})

describe('applyOps()', () => {
  it('does not mutate the input state', () => {
    const s = empty()
    applyOps(s, [{ kind: 'enable-rls', table: 'workbench' }])
    expect(s.rlsEnabled.size).toBe(0)
  })

  it('handles enable / disable RLS', () => {
    let s: State = empty()
    s = applyOps(s, [{ kind: 'enable-rls', table: 'workbench' }])
    expect(s.rlsEnabled.has('workbench')).toBe(true)
    s = applyOps(s, [{ kind: 'disable-rls', table: 'workbench' }])
    expect(s.rlsEnabled.has('workbench')).toBe(false)
  })

  it('handles force / unforce RLS independently from enable/disable', () => {
    let s: State = empty()
    s = applyOps(s, [
      { kind: 'enable-rls', table: 'workbench' },
      { kind: 'force-rls', table: 'workbench' },
    ])
    expect(s.rlsEnabled.has('workbench')).toBe(true)
    expect(s.rlsForced.has('workbench')).toBe(true)
    s = applyOps(s, [{ kind: 'unforce-rls', table: 'workbench' }])
    expect(s.rlsEnabled.has('workbench')).toBe(true)
    expect(s.rlsForced.has('workbench')).toBe(false)
  })

  it('creates and drops policies by (table, name) key', () => {
    let s: State = empty()
    s = applyOps(s, [policyOp('workbench', 'workbench_app_user_select')])
    expect(s.policies.has(policyMapKey('workbench', 'workbench_app_user_select'))).toBe(true)
    s = applyOps(s, [{ kind: 'drop-policy', table: 'workbench', name: 'workbench_app_user_select' }])
    expect(s.policies.size).toBe(0)
  })

  it('grants and revokes column privileges', () => {
    let s: State = empty()
    s = applyOps(s, [
      { kind: 'grant-column', table: 'workbench', column: 'apiKey', verb: 'select', role: 'app_system' },
    ])
    const key = columnGrantKey('workbench', 'apiKey', 'select', 'app_system')
    expect(s.columnGrants.has(key)).toBe(true)
    expect(s.columnGrants.get(key)?.column).toBe('apiKey')
    s = applyOps(s, [
      { kind: 'revoke-column', table: 'workbench', column: 'apiKey', verb: 'select', role: 'app_system' },
    ])
    expect(s.columnGrants.size).toBe(0)
  })

  it('creates and drops roles + memberships', () => {
    let s: State = empty()
    s = applyOps(s, [
      { kind: 'create-role', name: 'app_user', bypassesRls: false, nologin: true },
      { kind: 'create-role', name: 'app_system', bypassesRls: true, nologin: true },
      { kind: 'grant-role-membership', parent: 'app_user', child: 'app_system' },
    ])
    expect(s.roles.get('app_system')?.bypassesRls).toBe(true)
    expect(s.roleMemberships.has(roleMembershipKey('app_user', 'app_system'))).toBe(true)

    s = applyOps(s, [
      { kind: 'revoke-role-membership', parent: 'app_user', child: 'app_system' },
      { kind: 'drop-role', name: 'app_system' },
    ])
    expect(s.roleMemberships.size).toBe(0)
    expect(s.roles.has('app_system')).toBe(false)
  })

  it('is forward-replay equivalent across op batching', () => {
    const ops: Op[] = [
      { kind: 'create-role', name: 'app_user', bypassesRls: false, nologin: true },
      { kind: 'enable-rls', table: 'workbench' },
      policyOp('workbench', 'workbench_app_user_select'),
    ]
    const allAtOnce = applyOps(empty(), ops)
    let batched = empty()
    for (const op of ops) batched = applyOps(batched, [op])
    expect(batched.rlsEnabled.size).toBe(allAtOnce.rlsEnabled.size)
    expect(batched.policies.size).toBe(allAtOnce.policies.size)
    expect(batched.roles.size).toBe(allAtOnce.roles.size)
  })
})
