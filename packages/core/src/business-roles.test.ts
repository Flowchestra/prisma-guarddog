import { describe, expect, it } from 'vitest'

import { defineBusinessRoles } from './business-roles.js'

describe('defineBusinessRoles', () => {
  it('captures the role list and freezes the result', () => {
    const businessRoles = defineBusinessRoles({
      'org.admin': {},
      'workspace.admin': {},
      'workspace.editor': {},
      'workbench.admin': {},
      'workbench.editor': {},
    })
    expect(Object.keys(businessRoles.roles)).toEqual([
      'org.admin',
      'workspace.admin',
      'workspace.editor',
      'workbench.admin',
      'workbench.editor',
    ])
    expect(Object.isFrozen(businessRoles)).toBe(true)
    expect(Object.isFrozen(businessRoles.roles)).toBe(true)
  })

  it('rejects an empty role name', () => {
    expect(() =>
      defineBusinessRoles({
        '': {},
      })
    ).toThrow(/role name must be a non-empty string/)
  })

  it('accepts an empty role set (no business roles in use yet)', () => {
    const businessRoles = defineBusinessRoles({})
    expect(Object.keys(businessRoles.roles)).toEqual([])
  })
})
