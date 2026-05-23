import { describe, expect, it } from 'vitest'

import { defineAppRoles } from './app-roles.js'

describe('defineAppRoles', () => {
  it('captures the role list and freezes the result', () => {
    const appRoles = defineAppRoles({
      'org.admin': {},
      'workspace.admin': {},
      'workspace.editor': {},
      'workbench.admin': {},
      'workbench.editor': {},
    })
    expect(Object.keys(appRoles.roles)).toEqual([
      'org.admin',
      'workspace.admin',
      'workspace.editor',
      'workbench.admin',
      'workbench.editor',
    ])
    expect(Object.isFrozen(appRoles)).toBe(true)
    expect(Object.isFrozen(appRoles.roles)).toBe(true)
  })

  it('rejects an empty role name', () => {
    expect(() =>
      defineAppRoles({
        '': {},
      })
    ).toThrow(/role name must be a non-empty string/)
  })

  it('accepts an empty role set (no business roles in use yet)', () => {
    const appRoles = defineAppRoles({})
    expect(Object.keys(appRoles.roles)).toEqual([])
  })
})
