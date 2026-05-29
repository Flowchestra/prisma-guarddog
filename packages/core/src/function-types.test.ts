/**
 * Type-level tests for `p.fn(name, ...args)` (#15 / ADR-0026).
 *
 * The `@ts-expect-error` lines are the assertions: they pass type-check ONLY
 * if the function-name union + arity flow from `defineFunctions` →
 * `Guarddog` → the predicate builder. If `TFunctions` silently widened to the
 * unconstrained default, the directives would become "unused" and tsgo would
 * fail — so a green tsgo on this file proves the autocomplete is wired.
 *
 * Per ADR-0026, per-argument PG-type checking is intentionally out of scope
 * (FluentExpr is untyped at the SQL level); only the name and arity are
 * checked. Runtime here is incidental.
 */

import { describe, expect, it } from 'vitest'

import { defineAppRoles } from './app-roles.js'
import { defineClaims } from './claims.js'
import { defineDbRoles } from './db-roles.js'
import { defineFunctions } from './function-defs.js'
import { Guarddog } from './guarddog.js'
import { col } from './predicate.js'
import { defineResources } from './resources.js'

function fnGuard() {
  return new Guarddog({
    claims: defineClaims({ accessor: 'request.jwt.claims', shape: (c) => ({ sub: c.uuid() }) }),
    dbRoles: defineDbRoles({ app_user: { inherits: [], nologin: true } }),
    appRoles: defineAppRoles({}),
    resources: defineResources({}),
    functions: defineFunctions({
      schema: 'app',
      fns: {
        has_grant: {
          args: [
            { name: 'resource_id', type: 'text' },
            { name: 'user_id', type: 'text' },
          ],
          returns: 'boolean',
          body: 'SELECT true',
        },
      },
    }),
  })
}

describe('p.fn() name + arity type narrowing (#15)', () => {
  it('accepts a declared function name with correct arity', () => {
    const guard = fnGuard()
    guard
      .model('Doc')
      .policy('app_user')
      .select((p) => p.fn('has_grant', col('id'), p.claim('sub')))
    expect(guard.getPolicies().length).toBe(1)
  })

  it('rejects an unknown function name', () => {
    const guard = fnGuard()
    guard
      .model('Doc')
      .policy('app_user')
      // @ts-expect-error — 'ghost' is not a declared function name ('has_grant')
      .select((p) => p.fn('ghost', col('id')))
    expect(guard.getPolicies().length).toBe(1)
  })

  it('rejects a wrong arity for a declared function', () => {
    const guard = fnGuard()
    guard
      .model('Doc')
      .policy('app_user')
      // @ts-expect-error — has_grant takes 2 args; only 1 supplied
      .select((p) => p.fn('has_grant', col('id')))
    expect(guard.getPolicies().length).toBe(1)
  })

  it('leaves the name unconstrained (string) when no functions are declared', () => {
    const guard = new Guarddog({
      claims: defineClaims({ accessor: 'x', shape: (c) => ({ sub: c.uuid() }) }),
      dbRoles: defineDbRoles({ app_user: { inherits: [] } }),
      appRoles: defineAppRoles({}),
      resources: defineResources({}),
      // no functions → TFunctions defaults to unconstrained
    })
    guard
      .model('Foo')
      .policy('app_user')
      .select((p) => p.fn('anything', col('id'), 'a', 1, true))
    expect(guard.getPolicies().length).toBe(1)
  })
})
