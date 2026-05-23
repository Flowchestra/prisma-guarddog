import { describe, expect, it } from 'vitest'

import { defaultTableResolver, policyName, snakeCase } from './naming.js'

describe('snakeCase', () => {
  it.each([
    ['Workbench', 'workbench'],
    ['ScopeTarget', 'scope_target'],
    ['APIKey', 'api_key'],
    ['HTTPSConnection', 'https_connection'],
    ['User', 'user'],
    ['IO2Stream', 'io2_stream'],
    ['alreadyLower', 'already_lower'],
    ['already_snake', 'already_snake'],
  ])('converts %s -> %s', (input, expected) => {
    expect(snakeCase(input)).toBe(expected)
  })
})

describe('defaultTableResolver', () => {
  it('delegates to snakeCase', () => {
    expect(defaultTableResolver('ScopeTarget')).toBe('scope_target')
    expect(defaultTableResolver('Workbench')).toBe('workbench')
  })
})

describe('policyName', () => {
  it('builds <table>_<dbRole>_<verb> for regular policies', () => {
    expect(policyName({ table: 'workbench', dbRole: 'app_user', verb: 'select' })).toBe('workbench_app_user_select')
  })

  it('inserts the snake_cased discriminator for polymorphic targets', () => {
    expect(
      policyName({
        table: 'scope_target',
        dbRole: 'app_user',
        verb: 'select',
        discriminatorValue: 'Workspace',
      })
    ).toBe('scope_target_workspace_app_user_select')
  })

  it('lowercases the full output regardless of input casing', () => {
    expect(policyName({ table: 'X', dbRole: 'APP', verb: 'select' })).toBe('x_app_select')
  })

  it('handles all four verbs deterministically', () => {
    const base = { table: 'w', dbRole: 'r' } as const
    expect(policyName({ ...base, verb: 'select' })).toBe('w_r_select')
    expect(policyName({ ...base, verb: 'insert' })).toBe('w_r_insert')
    expect(policyName({ ...base, verb: 'update' })).toBe('w_r_update')
    expect(policyName({ ...base, verb: 'delete' })).toBe('w_r_delete')
  })
})
