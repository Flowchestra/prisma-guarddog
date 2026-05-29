/**
 * Function lifecycle: compileToOps emission + signature-aware diffStates
 * (#15 / ADR-0026).
 */

import { describe, expect, it } from 'vitest'

import { defineAppRoles } from './app-roles.js'
import { defineClaims } from './claims.js'
import { defineDbRoles } from './db-roles.js'
import { defineFunctions, type FunctionsDefinition } from './function-defs.js'
import { Guarddog } from './guarddog.js'
import { compileToOps, compileToState, diffStates } from './lifecycle.js'
import { type Op } from './ops.js'
import { col } from './predicate.js'
import { defineResources } from './resources.js'

function guardWith(functions: FunctionsDefinition, author?: (g: Guarddog) => void): Guarddog {
  const guard = new Guarddog({
    claims: defineClaims({ accessor: 'request.jwt.claims', shape: (c) => ({ sub: c.uuid() }) }),
    dbRoles: defineDbRoles({ app_user: { inherits: [], nologin: true }, app_system: { inherits: [], nologin: true } }),
    appRoles: defineAppRoles({}),
    resources: defineResources({}),
    functions,
  })
  author?.(guard)
  return guard
}

const TWO_FN = defineFunctions({
  schema: 'app',
  fns: {
    rank: {
      args: [{ name: 'role_text', type: 'text' }],
      returns: 'integer',
      volatility: 'immutable',
      body: `SELECT 1`,
    },
    has_grant: {
      args: [
        { name: 'resource_id', type: 'text' },
        { name: 'user_id', type: 'text' },
      ],
      returns: 'boolean',
      security: 'definer',
      dependsOn: ['rank'],
      grants: { execute: ['app_user', 'app_system'] },
      body: `SELECT true`,
    },
  },
})

function kinds(ops: ReadonlyArray<Op>): string[] {
  return ops.map((o) => o.kind)
}

describe('compileToOps() — functions', () => {
  it('emits create-schema before functions and functions in dependency order', () => {
    const ops = compileToOps(guardWith(TWO_FN))
    const k = kinds(ops)
    const iSchema = k.indexOf('create-schema')
    const fnOps = ops.filter((o): o is Extract<Op, { kind: 'create-function' }> => o.kind === 'create-function')
    expect(iSchema).toBeGreaterThanOrEqual(0)
    expect(iSchema).toBeLessThan(k.indexOf('create-function'))
    // dependency: rank (dependsOn target) before has_grant (dependent)
    expect(fnOps.map((o) => o.fn.name)).toEqual(['rank', 'has_grant'])
  })

  it('resolves defaults onto the function record', () => {
    const ops = compileToOps(guardWith(TWO_FN))
    const rank = ops.find(
      (o): o is Extract<Op, { kind: 'create-function' }> => o.kind === 'create-function' && o.fn.name === 'rank'
    )!
    expect(rank.fn.language).toBe('sql')
    expect(rank.fn.volatility).toBe('immutable')
    expect(rank.fn.parallel).toBe('unsafe')
    expect(rank.fn.security).toBe('invoker')
    expect(rank.fn.signature).toBe('app.rank(role_text text) -> integer')
  })

  it('emits a sorted grant-execute per declared execute role', () => {
    const ops = compileToOps(guardWith(TWO_FN))
    const grants = ops.filter((o): o is Extract<Op, { kind: 'grant-execute' }> => o.kind === 'grant-execute')
    // roles are emitted in sorted order
    expect(grants.map((g) => g.role)).toEqual(['app_system', 'app_user'])
    expect(grants[0]!.argTypes).toEqual(['text', 'text'])
  })

  it('emits no function ops when none are declared', () => {
    const guard = new Guarddog({
      claims: defineClaims({ accessor: 'x', shape: (c) => ({ sub: c.uuid() }) }),
      dbRoles: defineDbRoles({ app_user: { inherits: [] } }),
      appRoles: defineAppRoles({}),
      resources: defineResources({}),
    })
    const k = kinds(compileToOps(guard))
    expect(k).not.toContain('create-schema')
    expect(k).not.toContain('create-function')
  })

  it('records a p.fn() call as a fn Expr inside the policy', () => {
    const guard = guardWith(TWO_FN, (g) => {
      g.model('Doc')
        .policy('app_user')
        .select((p) => p.fn('has_grant', col('id'), p.claim('sub')))
    })
    const pol = guard.getPolicies()[0]!
    expect(pol.select!.using).toMatchObject({ kind: 'fn', name: 'has_grant' })
  })
})

describe('diffStates() — signature-aware function diffing', () => {
  it('creates schema + functions + grants from empty', () => {
    const target = compileToState(guardWith(TWO_FN))
    const ops = diffStates(compileToState(emptyGuard()), target)
    const k = kinds(ops)
    expect(k).toContain('create-schema')
    expect(k.filter((x) => x === 'create-function')).toHaveLength(2)
    expect(k.filter((x) => x === 'grant-execute')).toHaveLength(2)
    // schema before functions, functions before grants
    expect(k.indexOf('create-schema')).toBeLessThan(k.indexOf('create-function'))
    expect(k.lastIndexOf('create-function')).toBeLessThan(k.indexOf('grant-execute'))
  })

  it('is a no-op when nothing changed', () => {
    const a = compileToState(guardWith(TWO_FN))
    const b = compileToState(guardWith(TWO_FN))
    expect(diffStates(a, b)).toHaveLength(0)
  })

  it('uses CREATE OR REPLACE (no drop) for a body-only change', () => {
    const before = compileToState(guardWith(TWO_FN))
    const after = compileToState(
      guardWith(
        defineFunctions({
          schema: 'app',
          fns: {
            rank: {
              args: [{ name: 'role_text', type: 'text' }],
              returns: 'integer',
              volatility: 'immutable',
              body: 'SELECT 1',
            },
            has_grant: {
              args: [
                { name: 'resource_id', type: 'text' },
                { name: 'user_id', type: 'text' },
              ],
              returns: 'boolean',
              security: 'definer',
              dependsOn: ['rank'],
              grants: { execute: ['app_user', 'app_system'] },
              body: `SELECT false`, // body changed
            },
          },
        })
      )
    )
    const ops = diffStates(before, after)
    expect(kinds(ops)).toContain('create-function')
    expect(kinds(ops)).not.toContain('drop-function')
  })

  it('DROPs + re-CREATEs + re-GRANTs on a signature change', () => {
    const before = compileToState(guardWith(TWO_FN))
    const after = compileToState(
      guardWith(
        defineFunctions({
          schema: 'app',
          fns: {
            rank: {
              args: [{ name: 'role_text', type: 'text' }],
              returns: 'integer',
              volatility: 'immutable',
              body: 'SELECT 1',
            },
            has_grant: {
              args: [
                { name: 'resource_id', type: 'text' },
                { name: 'user_id', type: 'text' },
                { name: 'min_role', type: 'text', default: 'NULL' }, // new arg → new signature
              ],
              returns: 'boolean',
              security: 'definer',
              dependsOn: ['rank'],
              grants: { execute: ['app_user', 'app_system'] },
              body: `SELECT true`,
            },
          },
        })
      )
    )
    const ops = diffStates(before, after)
    const drop = ops.find((o): o is Extract<Op, { kind: 'drop-function' }> => o.kind === 'drop-function')
    expect(drop?.name).toBe('has_grant')
    expect(drop?.argTypes).toEqual(['text', 'text']) // OLD signature
    expect(ops.some((o) => o.kind === 'create-function')).toBe(true)
    // grants were wiped by the drop, so they must be re-granted (not skipped)
    expect(ops.filter((o) => o.kind === 'grant-execute')).toHaveLength(2)
    // drop precedes create
    expect(kinds(ops).indexOf('drop-function')).toBeLessThan(kinds(ops).indexOf('create-function'))
  })

  it('drops a removed function and revokes nothing extra', () => {
    const before = compileToState(guardWith(TWO_FN))
    const after = compileToState(
      guardWith(
        defineFunctions({
          schema: 'app',
          fns: {
            rank: {
              args: [{ name: 'role_text', type: 'text' }],
              returns: 'integer',
              volatility: 'immutable',
              body: 'SELECT 1',
            },
          },
        })
      )
    )
    const ops = diffStates(before, after)
    const drop = ops.find((o): o is Extract<Op, { kind: 'drop-function' }> => o.kind === 'drop-function')
    expect(drop?.name).toBe('has_grant')
    // removed function's grants are gone with the drop — no explicit revoke
    expect(ops.some((o) => o.kind === 'revoke-execute')).toBe(false)
  })

  it('revokes a single removed grant on an otherwise-unchanged function', () => {
    const before = compileToState(guardWith(TWO_FN))
    const after = compileToState(
      guardWith(
        defineFunctions({
          schema: 'app',
          fns: {
            rank: {
              args: [{ name: 'role_text', type: 'text' }],
              returns: 'integer',
              volatility: 'immutable',
              body: 'SELECT 1',
            },
            has_grant: {
              args: [
                { name: 'resource_id', type: 'text' },
                { name: 'user_id', type: 'text' },
              ],
              returns: 'boolean',
              security: 'definer',
              dependsOn: ['rank'],
              grants: { execute: ['app_user'] }, // dropped app_system
              body: `SELECT true`,
            },
          },
        })
      )
    )
    const ops = diffStates(before, after)
    const revokes = ops.filter((o): o is Extract<Op, { kind: 'revoke-execute' }> => o.kind === 'revoke-execute')
    expect(revokes).toHaveLength(1)
    expect(revokes[0]!.role).toBe('app_system')
    expect(ops.some((o) => o.kind === 'drop-function')).toBe(false)
  })
})

function emptyGuard(): Guarddog {
  return new Guarddog({
    claims: defineClaims({ accessor: 'x', shape: (c) => ({ sub: c.uuid() }) }),
    dbRoles: defineDbRoles({ app_user: { inherits: [] }, app_system: { inherits: [] } }),
    appRoles: defineAppRoles({}),
    resources: defineResources({}),
  })
}
