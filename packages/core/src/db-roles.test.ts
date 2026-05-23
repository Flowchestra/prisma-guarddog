import { describe, expect, it } from 'vitest'

import { defineDbRoles } from './db-roles.js'

describe('defineDbRoles', () => {
  it('normalizes specs and freezes the result', () => {
    const dbRoles = defineDbRoles({
      app_user: { inherits: [] },
      app_system: { inherits: ['app_user'], bypassesRls: true },
    })
    expect(dbRoles.roles.app_user).toMatchObject({ inherits: [] })
    expect(dbRoles.roles.app_system).toMatchObject({
      inherits: ['app_user'],
      bypassesRls: true,
    })
    expect(Object.isFrozen(dbRoles)).toBe(true)
    expect(Object.isFrozen(dbRoles.roles)).toBe(true)
    expect(Object.isFrozen(dbRoles.roles.app_user)).toBe(true)
  })

  it('defaults inherits to [] when omitted', () => {
    const dbRoles = defineDbRoles({
      app_user: {},
    })
    expect(dbRoles.roles.app_user.inherits).toEqual([])
  })

  it('rejects inherits referencing an unknown role', () => {
    expect(() =>
      defineDbRoles({
        // @ts-expect-error — 'ghost' is not a key of the same call
        app_user: { inherits: ['ghost'] },
      })
    ).toThrow(/inherits from "ghost", but "ghost" is not defined/)
  })

  it('rejects self-inheritance', () => {
    expect(() =>
      defineDbRoles({
        app_user: { inherits: ['app_user'] },
      })
    ).toThrow(/cannot inherit from itself/)
  })

  it('rejects an inheritance cycle', () => {
    expect(() =>
      defineDbRoles({
        a: { inherits: ['b'] },
        b: { inherits: ['c'] },
        c: { inherits: ['a'] },
      })
    ).toThrow(/inheritance cycle detected/)
  })

  it('allows forward references in the same call', () => {
    const dbRoles = defineDbRoles({
      app_user: { inherits: ['app_system'] },
      app_system: { inherits: [] },
    })
    expect(dbRoles.roles.app_user.inherits).toEqual(['app_system'])
  })

  it('preserves bypassesRls and nologin flags', () => {
    const dbRoles = defineDbRoles({
      app_user: { inherits: [], nologin: true },
      app_system: { inherits: ['app_user'], bypassesRls: true, nologin: true },
    })
    expect(dbRoles.roles.app_user.nologin).toBe(true)
    expect(dbRoles.roles.app_user.bypassesRls).toBeUndefined()
    expect(dbRoles.roles.app_system.bypassesRls).toBe(true)
    expect(dbRoles.roles.app_system.nologin).toBe(true)
  })
})
