import { describe, expect, it } from 'vitest'

import type { PolymorphicAst, PolymorphicTargetAst, PolymorphicTargetPolicyAst } from './ast.js'
import { defineBusinessRoles } from './business-roles.js'
import { defineClaims } from './claims.js'
import { defineDbRoles } from './db-roles.js'
import { Guarddog } from './guarddog.js'
import { col } from './predicate.js'
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
    }),
    businessRoles: defineBusinessRoles({
      'workspace.admin': {},
      'workbench.editor': {},
    }),
    resources: defineResources({
      Workspace: { model: 'Workspace', id: 'id' },
    }),
  })
}

describe('Guarddog.polymorphic basics', () => {
  it('registers a polymorphic with discriminator and table', () => {
    const guard = makeGuard()
    guard.polymorphic('ScopeTarget', { discriminator: 'targetType' }).table('public.scope_targets')

    const polys = guard.getPolymorphics()
    expect(polys).toHaveLength(1)
    expect(polys[0]?.modelName).toBe('ScopeTarget')
    expect(polys[0]?.discriminator).toBe('targetType')
    expect(polys[0]?.table).toBe('public.scope_targets')
    expect(polys[0]?.targets).toEqual([])
  })

  it('table is undefined when not overridden', () => {
    const guard = makeGuard()
    guard.polymorphic('ScopeTarget', { discriminator: 'targetType' })
    expect(guard.getPolymorphics()[0]?.table).toBeUndefined()
  })

  it('returns the same builder on idempotent re-fetch with matching discriminator', () => {
    const guard = makeGuard()
    const a = guard.polymorphic('ScopeTarget', { discriminator: 'targetType' })
    const b = guard.polymorphic('ScopeTarget', { discriminator: 'targetType' })
    expect(a).toBe(b)
    expect(guard.getPolymorphics()).toHaveLength(1)
  })

  it('rejects re-fetch with a different discriminator', () => {
    const guard = makeGuard()
    guard.polymorphic('ScopeTarget', { discriminator: 'targetType' })
    expect(() => guard.polymorphic('ScopeTarget', { discriminator: 'kind' })).toThrow(
      /redeclared with discriminator="kind"/
    )
  })

  it('rejects empty modelName', () => {
    expect(() => makeGuard().polymorphic('', { discriminator: 'x' })).toThrow(/modelName must be a non-empty string/)
  })

  it('rejects empty discriminator', () => {
    expect(() => makeGuard().polymorphic('X', { discriminator: '' })).toThrow(
      /discriminator must be a non-empty string/
    )
  })
})

describe('Guarddog mutual exclusion across model/noPolicy/polymorphic', () => {
  it('rejects polymorphic() if model() was called for the same name', () => {
    const guard = makeGuard()
    guard.model('ScopeTarget')
    expect(() => guard.polymorphic('ScopeTarget', { discriminator: 'targetType' })).toThrow(
      /previously declared via \.model/
    )
  })

  it('rejects polymorphic() if noPolicy() was called for the same name', () => {
    const guard = makeGuard()
    guard.noPolicy('ScopeTarget', { reason: 'unused' })
    expect(() => guard.polymorphic('ScopeTarget', { discriminator: 'targetType' })).toThrow(
      /previously declared as noPolicy/
    )
  })

  it('rejects model() if polymorphic() was called for the same name', () => {
    const guard = makeGuard()
    guard.polymorphic('ScopeTarget', { discriminator: 'targetType' })
    expect(() => guard.model('ScopeTarget')).toThrow(/previously declared as polymorphic/)
  })

  it('rejects noPolicy() if polymorphic() was called for the same name', () => {
    const guard = makeGuard()
    guard.polymorphic('ScopeTarget', { discriminator: 'targetType' })
    expect(() => guard.noPolicy('ScopeTarget', { reason: 'x' })).toThrow(/previously declared as polymorphic/)
  })
})

describe('PolymorphicBuilder.target', () => {
  it('registers target builders keyed by discriminator value', () => {
    const guard = makeGuard()
    const poly = guard.polymorphic('ScopeTarget', { discriminator: 'targetType' })
    poly.target('Workspace', { model: 'Workspace' })
    poly.target('Workbench', { model: 'Workbench' })
    poly.target('File', { model: 'File' })

    const ast = guard.getPolymorphics()[0] as PolymorphicAst
    expect(ast.targets).toHaveLength(3)
    expect(ast.targets.map((t) => t.discriminatorValue)).toEqual(['Workspace', 'Workbench', 'File'])
    expect(ast.targets.map((t) => t.targetModelName)).toEqual(['Workspace', 'Workbench', 'File'])
  })

  it('is idempotent on repeated calls with matching model', () => {
    const guard = makeGuard()
    const poly = guard.polymorphic('ScopeTarget', { discriminator: 'targetType' })
    const a = poly.target('Workspace', { model: 'Workspace' })
    const b = poly.target('Workspace', { model: 'Workspace' })
    expect(a).toBe(b)
    expect(guard.getPolymorphics()[0]?.targets).toHaveLength(1)
  })

  it('rejects mismatched model on re-fetch', () => {
    const guard = makeGuard()
    const poly = guard.polymorphic('ScopeTarget', { discriminator: 'targetType' })
    poly.target('Workspace', { model: 'Workspace' })
    expect(() => poly.target('Workspace', { model: 'OtherModel' })).toThrow(
      /previously declared with model="Workspace", now redeclared with model="OtherModel"/
    )
  })

  it('rejects empty discriminatorValue or empty model', () => {
    const guard = makeGuard()
    const poly = guard.polymorphic('ScopeTarget', { discriminator: 'targetType' })
    expect(() => poly.target('', { model: 'X' })).toThrow(/discriminatorValue must be a non-empty string/)
    expect(() => poly.target('Workspace', { model: '' })).toThrow(/model must be a non-empty string/)
  })
})

describe('PolymorphicTargetPolicyBuilder authoring', () => {
  it('authors a SELECT policy on a target', () => {
    const guard = makeGuard()
    const poly = guard.polymorphic('ScopeTarget', { discriminator: 'targetType' })
    poly
      .target('Workspace', { model: 'Workspace' })
      .policy('app_user')
      .select((p) =>
        p
          .claim('tenantId')
          .eq(col('tenantId'))
          .and(p.hasRole('workspace.admin', col('targetId')))
      )

    const target = guard.getPolymorphics()[0]?.targets[0] as PolymorphicTargetAst
    expect(target.policies).toHaveLength(1)
    const policy = target.policies[0] as PolymorphicTargetPolicyAst
    expect(policy.dbRole).toBe('app_user')
    expect(policy.select?.using.kind).toBe('and')
  })

  it('idempotent policy() returns the same builder per (target, dbRole)', () => {
    const guard = makeGuard()
    const target = guard
      .polymorphic('ScopeTarget', { discriminator: 'targetType' })
      .target('Workspace', { model: 'Workspace' })
    const a = target.policy('app_user')
    const b = target.policy('app_user')
    expect(a).toBe(b)
    expect(guard.getPolymorphics()[0]?.targets[0]?.policies).toHaveLength(1)
  })

  it('all four verbs land on the same PolymorphicTargetPolicyAst', () => {
    const guard = makeGuard()
    guard
      .polymorphic('ScopeTarget', { discriminator: 'targetType' })
      .target('Workspace', { model: 'Workspace' })
      .policy('app_user')
      .select((p) => p.claim('tenantId').eq(col('tenantId')))
      .insert({ check: (p) => p.hasRole('workspace.admin', col('targetId')) })
      .update({
        using: (p) => p.isOwner(col('ownerId')),
        check: (p) => p.hasRole('workspace.admin', col('targetId')),
      })
      .delete({ using: (p) => p.hasRole('workspace.admin', col('targetId')) })

    const policy = guard.getPolymorphics()[0]?.targets[0]?.policies[0] as PolymorphicTargetPolicyAst
    expect(policy.select?.using.kind).toBe('binop')
    expect(policy.insert?.check.kind).toBe('hasRole')
    expect(policy.update?.using.kind).toBe('isOwner')
    expect(policy.update?.check.kind).toBe('hasRole')
    expect(policy.delete?.using.kind).toBe('hasRole')
  })

  it('rawSql wraps a verb as Expr.raw', () => {
    const guard = makeGuard()
    guard
      .polymorphic('ScopeTarget', { discriminator: 'targetType' })
      .target('Workspace', { model: 'Workspace' })
      .policy('app_user')
      .rawSql('select', 'tenant_id IS NOT NULL')

    const policy = guard.getPolymorphics()[0]?.targets[0]?.policies[0] as PolymorphicTargetPolicyAst
    expect(policy.select?.using).toEqual({ kind: 'raw', sql: 'tenant_id IS NOT NULL' })
  })

  it('todo accumulates markers', () => {
    const guard = makeGuard()
    guard
      .polymorphic('ScopeTarget', { discriminator: 'targetType' })
      .target('Workspace', { model: 'Workspace' })
      .policy('app_user')
      .rawSql('select', 'x = y')
      .todo('Replace raw SQL with typed predicates')
      .todo('Audit role coverage with security team')

    const policy = guard.getPolymorphics()[0]?.targets[0]?.policies[0] as PolymorphicTargetPolicyAst
    expect(policy.todos).toEqual(['Replace raw SQL with typed predicates', 'Audit role coverage with security team'])
  })

  it('returns a deeply-frozen AST', () => {
    const guard = makeGuard()
    guard
      .polymorphic('ScopeTarget', { discriminator: 'targetType' })
      .target('Workspace', { model: 'Workspace' })
      .policy('app_user')
      .select((p) => p.literal(true))

    const polys = guard.getPolymorphics()
    expect(Object.isFrozen(polys)).toBe(true)
    expect(Object.isFrozen(polys[0])).toBe(true)
    expect(Object.isFrozen(polys[0]?.targets)).toBe(true)
    expect(Object.isFrozen(polys[0]?.targets[0])).toBe(true)
    expect(Object.isFrozen(polys[0]?.targets[0]?.policies)).toBe(true)
    expect(Object.isFrozen(polys[0]?.targets[0]?.policies[0])).toBe(true)
  })

  it('@ts-expect-error: policy() type-checks dbRole against registered set', () => {
    const guard = makeGuard()
    guard
      .polymorphic('ScopeTarget', { discriminator: 'targetType' })
      .target('Workspace', { model: 'Workspace' })
      // @ts-expect-error — 'unknown_role' is not in the registered dbRoles
      .policy('unknown_role')
      .select((p) => p.literal(true))
    // Compile-time error; runtime still produces the AST.
    expect(guard.getPolymorphics()[0]?.targets[0]?.policies).toHaveLength(1)
  })
})
