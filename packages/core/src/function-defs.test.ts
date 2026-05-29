/**
 * `defineFunctions` validation + ordering (#15 / ADR-0026).
 */

import { describe, expect, it } from 'vitest'

import { defineFunctions, orderFunctions } from './function-defs.js'

const RANK = {
  args: [{ name: 'role_text', type: 'text' }],
  returns: 'integer',
  volatility: 'immutable',
  body: `SELECT 1`,
} as const

describe('defineFunctions() validation', () => {
  it('accepts a minimal valid declaration and freezes it', () => {
    const def = defineFunctions({ schema: 'app', fns: { rank: RANK } })
    expect(def.schema).toBe('app')
    expect(Object.isFrozen(def)).toBe(true)
    expect(Object.isFrozen(def.fns)).toBe(true)
    expect(Object.keys(def.fns)).toEqual(['rank'])
  })

  it('rejects an empty schema', () => {
    expect(() => defineFunctions({ schema: '', fns: { rank: RANK } })).toThrow(/schema must be a non-empty string/)
  })

  it('rejects an empty fns map', () => {
    expect(() => defineFunctions({ schema: 'app', fns: {} })).toThrow(/at least one function/)
  })

  it('rejects an empty body', () => {
    expect(() => defineFunctions({ schema: 'app', fns: { f: { args: [], returns: 'boolean', body: '' } } })).toThrow(
      /body must be a non-empty string/
    )
  })

  it('rejects an empty returns', () => {
    expect(() => defineFunctions({ schema: 'app', fns: { f: { args: [], returns: '', body: 'SELECT 1' } } })).toThrow(
      /returns must be a non-empty string/
    )
  })

  it('rejects duplicate argument names', () => {
    expect(() =>
      defineFunctions({
        schema: 'app',
        fns: {
          f: {
            args: [
              { name: 'x', type: 'text' },
              { name: 'x', type: 'integer' },
            ],
            returns: 'boolean',
            body: 'SELECT true',
          },
        },
      })
    ).toThrow(/duplicate argument "x"/)
  })

  it('rejects a non-defaulted argument that follows a defaulted one', () => {
    expect(() =>
      defineFunctions({
        schema: 'app',
        fns: {
          f: {
            args: [
              { name: 'a', type: 'text', default: 'NULL' },
              { name: 'b', type: 'text' },
            ],
            returns: 'boolean',
            body: 'SELECT true',
          },
        },
      })
    ).toThrow(/defaulted arguments to be trailing/)
  })

  it('rejects an invalid volatility/parallel/security/language', () => {
    const base = { args: [], returns: 'boolean', body: 'SELECT true' }
    expect(() => defineFunctions({ schema: 'app', fns: { f: { ...base, volatility: 'sometimes' as never } } })).toThrow(
      /volatility must be one of/
    )
    expect(() => defineFunctions({ schema: 'app', fns: { f: { ...base, parallel: 'maybe' as never } } })).toThrow(
      /parallel must be one of/
    )
    expect(() => defineFunctions({ schema: 'app', fns: { f: { ...base, security: 'nobody' as never } } })).toThrow(
      /security must be one of/
    )
    expect(() => defineFunctions({ schema: 'app', fns: { f: { ...base, language: 'rust' as never } } })).toThrow(
      /language must be one of/
    )
  })

  it('rejects a dependsOn that names an undeclared function', () => {
    expect(() =>
      defineFunctions({
        schema: 'app',
        fns: { f: { args: [], returns: 'boolean', body: 'SELECT true', dependsOn: ['ghost'] } },
      })
    ).toThrow(/dependsOn references "ghost"/)
  })

  it('rejects a self-dependency', () => {
    expect(() =>
      defineFunctions({
        schema: 'app',
        fns: { f: { args: [], returns: 'boolean', body: 'SELECT true', dependsOn: ['f'] } },
      })
    ).toThrow(/cannot dependsOn itself/)
  })

  it('detects a dependency cycle', () => {
    expect(() =>
      defineFunctions({
        schema: 'app',
        fns: {
          a: { args: [], returns: 'boolean', body: 'x', dependsOn: ['b'] },
          b: { args: [], returns: 'boolean', body: 'y', dependsOn: ['a'] },
        },
      })
    ).toThrow(/cycle detected/)
  })
})

describe('orderFunctions()', () => {
  it('places dependencies before dependents', () => {
    const def = defineFunctions({
      schema: 'app',
      fns: {
        dependent: { args: [], returns: 'boolean', body: 'x', dependsOn: ['base'] },
        base: { args: [{ name: 'r', type: 'text' }], returns: 'integer', body: 'y' },
      },
    })
    const order = orderFunctions(def).map((o) => o.name)
    expect(order.indexOf('base')).toBeLessThan(order.indexOf('dependent'))
  })

  it('breaks ties by declaration order', () => {
    const def = defineFunctions({
      schema: 'app',
      fns: {
        first: { args: [], returns: 'boolean', body: 'x' },
        second: { args: [], returns: 'boolean', body: 'y' },
      },
    })
    expect(orderFunctions(def).map((o) => o.name)).toEqual(['first', 'second'])
  })
})
