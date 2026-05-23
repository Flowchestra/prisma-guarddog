import { describe, expect, it } from 'vitest'

import { defaultTableResolver, formatLiteral, policyName, quoteIdent, quoteString } from './identifiers.js'

describe('quoteIdent', () => {
  it('returns safe identifiers unquoted', () => {
    expect(quoteIdent('workbench')).toBe('workbench')
    expect(quoteIdent('scope_target')).toBe('scope_target')
    expect(quoteIdent('_internal')).toBe('_internal')
    expect(quoteIdent('col_42')).toBe('col_42')
  })

  it('quotes identifiers with uppercase letters', () => {
    expect(quoteIdent('CamelCase')).toBe('"CamelCase"')
  })

  it('quotes identifiers starting with a digit', () => {
    expect(quoteIdent('1table')).toBe('"1table"')
  })

  it('escapes embedded double-quotes by doubling them', () => {
    expect(quoteIdent('weird"name')).toBe('"weird""name"')
  })

  it('rejects empty identifier', () => {
    expect(() => quoteIdent('')).toThrow(/identifier must be non-empty/)
  })
})

describe('quoteString', () => {
  it('wraps in single quotes', () => {
    expect(quoteString('hello')).toBe("'hello'")
  })

  it('doubles internal single quotes', () => {
    expect(quoteString("o'reilly")).toBe("'o''reilly'")
  })

  it('handles empty string', () => {
    expect(quoteString('')).toBe("''")
  })
})

describe('formatLiteral', () => {
  it('formats null as NULL', () => {
    expect(formatLiteral(null)).toBe('NULL')
  })
  it('formats booleans', () => {
    expect(formatLiteral(true)).toBe('TRUE')
    expect(formatLiteral(false)).toBe('FALSE')
  })
  it('formats integers and floats', () => {
    expect(formatLiteral(42)).toBe('42')
    expect(formatLiteral(-7)).toBe('-7')
    expect(formatLiteral(3.14)).toBe('3.14')
  })
  it('formats strings', () => {
    expect(formatLiteral('hi')).toBe("'hi'")
    expect(formatLiteral("o'brien")).toBe("'o''brien'")
  })
  it('rejects NaN and Infinity', () => {
    expect(() => formatLiteral(Number.NaN)).toThrow(/non-finite number/)
    expect(() => formatLiteral(Number.POSITIVE_INFINITY)).toThrow(/non-finite number/)
  })
})

describe('defaultTableResolver', () => {
  it.each([
    ['Workbench', 'workbench'],
    ['ScopeTarget', 'scope_target'],
    ['APIKey', 'api_key'],
    ['HTTPSConnection', 'https_connection'],
    ['User', 'user'],
    ['IO2Stream', 'io2_stream'],
  ])('converts %s -> %s', (input, expected) => {
    expect(defaultTableResolver(input)).toBe(expected)
  })
})

describe('policyName', () => {
  it('builds <table>_<dbRole>_<verb>', () => {
    expect(policyName({ table: 'workbench', dbRole: 'app_user', verb: 'select' })).toBe('workbench_app_user_select')
  })

  it('inserts the snake_cased discriminator value for polymorphic targets', () => {
    expect(
      policyName({
        table: 'scope_target',
        dbRole: 'app_user',
        verb: 'select',
        discriminatorValue: 'Workspace',
      })
    ).toBe('scope_target_workspace_app_user_select')
  })

  it('lowercases the full output', () => {
    expect(policyName({ table: 'X', dbRole: 'APP', verb: 'SELECT' })).toBe('x_app_select')
  })
})
