import { describe, expect, it } from 'vitest'

import { defineAppRoles } from './app-roles.js'
import { defineClaims } from './claims.js'
import { defineDbRoles } from './db-roles.js'
import { Guarddog } from './guarddog.js'
import { col } from './predicate.js'
import { defineResourceGrants } from './resource-grants.js'
import { defineResources } from './resources.js'
import { defineSchema, materializeSchema } from './schema.js'

const baseClaims = () =>
  defineClaims({
    accessor: 'request.jwt.claims',
    shape: (c) => ({ sub: c.uuid(), tenantId: c.uuid() }),
  })

const baseDbRoles = () =>
  defineDbRoles({
    app_user: { inherits: [] },
    app_system: { inherits: ['app_user'], bypassesRls: true },
  })

const baseAppRoles = () =>
  defineAppRoles({
    'workspace.admin': {},
    'workspace.editor': {},
  })

const baseResources = () =>
  defineResources({
    Workspace: { model: 'Workspace', id: 'id' },
  })

describe('defineSchema', () => {
  it('captures the primitives and freezes the result', () => {
    const schema = defineSchema({
      claims: baseClaims(),
      dbRoles: baseDbRoles(),
      appRoles: baseAppRoles(),
      resources: baseResources(),
      policies: () => {},
    })
    expect(Object.isFrozen(schema)).toBe(true)
    expect(schema.claims.accessor).toBe('request.jwt.claims')
    expect(schema.dbRoles.roles.app_user).toBeDefined()
    expect(schema.appRoles.roles['workspace.admin']).toBeDefined()
    expect(schema.resources.resources.Workspace).toBeDefined()
  })

  it('captures the policies callback without invoking it eagerly', () => {
    let calls = 0
    const schema = defineSchema({
      claims: baseClaims(),
      dbRoles: baseDbRoles(),
      appRoles: baseAppRoles(),
      resources: baseResources(),
      policies: () => {
        calls++
      },
    })
    expect(typeof schema.policies).toBe('function')
    expect(calls).toBe(0) // defineSchema must NOT invoke the callback eagerly
    materializeSchema(schema)
    expect(calls).toBe(1)
    materializeSchema(schema)
    expect(calls).toBe(2) // a fresh invocation each materialize call
  })

  it('honors an optional resourceGrants slot', () => {
    const schema = defineSchema({
      claims: baseClaims(),
      dbRoles: baseDbRoles(),
      appRoles: baseAppRoles(),
      resources: baseResources(),
      resourceGrants: defineResourceGrants({ actions: ['read', 'write'] as const }),
      policies: () => {},
    })
    expect(schema.resourceGrants?.actions).toEqual(['read', 'write'])
  })

  it('resourceGrants is optional', () => {
    const schema = defineSchema({
      claims: baseClaims(),
      dbRoles: baseDbRoles(),
      appRoles: baseAppRoles(),
      resources: baseResources(),
      policies: () => {},
    })
    expect(schema.resourceGrants).toBeUndefined()
  })
})

describe('materializeSchema', () => {
  it('returns a Guarddog instance with all primitives wired', () => {
    const schema = defineSchema({
      claims: baseClaims(),
      dbRoles: baseDbRoles(),
      appRoles: baseAppRoles(),
      resources: baseResources(),
      policies: () => {},
    })
    const guard = materializeSchema(schema)
    expect(guard).toBeInstanceOf(Guarddog)
    expect(guard.config.claims).toBe(schema.claims)
    expect(guard.config.dbRoles).toBe(schema.dbRoles)
    expect(guard.config.appRoles).toBe(schema.appRoles)
    expect(guard.config.resources).toBe(schema.resources)
  })

  it('invokes the policies callback once and registers what it declared', () => {
    let calls = 0
    const schema = defineSchema({
      claims: baseClaims(),
      dbRoles: baseDbRoles(),
      appRoles: baseAppRoles(),
      resources: baseResources(),
      resourceGrants: defineResourceGrants({ actions: ['edit'] as const }),
      policies(guard) {
        calls++
        guard
          .model('Workspace')
          .policy('app_user')
          .select((p) => p.hasGrant('edit', col('id')))
      },
    })
    const guard = materializeSchema(schema)
    expect(calls).toBe(1)
    expect(guard.getPolicies()).toHaveLength(1)
    expect(guard.getPolicies()[0]?.model).toBe('Workspace')
  })

  it('propagates resourceGrants config to the Guarddog instance', () => {
    const schema = defineSchema({
      claims: baseClaims(),
      dbRoles: baseDbRoles(),
      appRoles: baseAppRoles(),
      resources: baseResources(),
      resourceGrants: defineResourceGrants({ actions: ['read'] as const, claimPath: 'perms' }),
      policies: () => {},
    })
    const guard = materializeSchema(schema)
    expect(guard.config.resourceGrants?.claimPath).toBe('perms')
    expect(guard.config.resourceGrants?.actions).toEqual(['read'])
  })

  it('produces independent Guarddog instances on repeated calls (no shared state)', () => {
    const schema = defineSchema({
      claims: baseClaims(),
      dbRoles: baseDbRoles(),
      appRoles: baseAppRoles(),
      resources: baseResources(),
      policies(guard) {
        guard
          .model('Workspace')
          .policy('app_user')
          .select((p) => p.literal(true))
      },
    })
    const a = materializeSchema(schema)
    const b = materializeSchema(schema)
    expect(a).not.toBe(b)
    expect(a.getPolicies()).toHaveLength(1)
    expect(b.getPolicies()).toHaveLength(1)
    expect(a.getPolicies()).not.toBe(b.getPolicies())
  })

  it('threads the type generics — TActions narrows through to guard.config', () => {
    const schema = defineSchema({
      claims: baseClaims(),
      dbRoles: baseDbRoles(),
      appRoles: baseAppRoles(),
      resources: baseResources(),
      resourceGrants: defineResourceGrants({ actions: ['read', 'write'] as const }),
      policies: () => {},
    })
    const guard = materializeSchema(schema)
    // Type-level check: actions[] should narrow to ('read' | 'write')[].
    type Actions = NonNullable<typeof guard.config.resourceGrants>['actions'][number]
    const _check: Actions = 'read'
    void _check
    expect(guard.config.resourceGrants?.actions).toContain('read')
  })
})
