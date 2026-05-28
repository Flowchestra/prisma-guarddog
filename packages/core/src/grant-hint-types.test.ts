/**
 * Type-level tests for the `hasGrant` table-hint autocomplete (#12 / ADR-0025).
 *
 * These assert COMPILE-TIME behavior: the `tables`-key union must flow from
 * `defineResourceGrants` → `Guarddog` → the `select((p) => ...)` predicate
 * builder so `p.hasGrant(..., { table })` type-checks the hint. The
 * `@ts-expect-error` lines are the real assertions — they pass type-check
 * ONLY if the narrowing works. If `TGrantTableKeys` silently widened to
 * `string`, the directives would become "unused" and tsgo would fail. So a
 * green `tsgo` on this file is the proof the autocomplete is wired.
 *
 * Runtime is incidental (the authoring just registers policies); the value
 * is in the type-check.
 */

import { describe, expect, it } from 'vitest'

import { defineAppRoles } from './app-roles.js'
import { defineClaims } from './claims.js'
import { defineDbRoles } from './db-roles.js'
import { Guarddog } from './guarddog.js'
import { col } from './predicate.js'
import { defineResourceGrants } from './resource-grants.js'
import { defineResources } from './resources.js'
import { defineSchema, materializeSchema } from './schema.js'

function tableGuard() {
  return new Guarddog({
    claims: defineClaims({ accessor: 'request.jwt.claims', shape: (c) => ({ sub: c.uuid() }) }),
    dbRoles: defineDbRoles({ app_user: { inherits: [], nologin: true } }),
    appRoles: defineAppRoles({}),
    resources: defineResources({}),
    resourceGrants: defineResourceGrants({
      source: 'table',
      actions: ['READER', 'EDITOR'] as const,
      tables: {
        workspaceId: { name: 'workspace_grants', principalColumn: 'user_id', actionsColumn: 'actions' },
        workbenchId: { name: 'workbench_grants', principalColumn: 'user_id', actionsColumn: 'actions' },
      },
    }),
  })
}

describe('hasGrant table-hint type narrowing (#12)', () => {
  it('accepts a declared tables key and rejects an unknown one (via new Guarddog)', () => {
    const guard = tableGuard()

    guard
      .model('Workspace')
      .policy('app_user')
      .select((p) => p.hasGrant('READER', col('id'), { table: 'workspaceId' }))

    guard
      .model('Workbench')
      .policy('app_user')
      .select((p) =>
        // @ts-expect-error — 'nope' is not a declared tables key ('workspaceId' | 'workbenchId')
        p.hasGrant('READER', col('id'), { table: 'nope' })
      )

    expect(guard.getPolicies().length).toBeGreaterThan(0)
  })

  it('narrows through the defineSchema → materializeSchema path too', () => {
    const schema = defineSchema({
      claims: defineClaims({ accessor: 'request.jwt.claims', shape: (c) => ({ sub: c.uuid() }) }),
      dbRoles: defineDbRoles({ app_user: { inherits: [], nologin: true } }),
      appRoles: defineAppRoles({}),
      resources: defineResources({}),
      resourceGrants: defineResourceGrants({
        source: 'table',
        actions: ['READER'] as const,
        tables: {
          workspaceId: { name: 'workspace_grants', principalColumn: 'user_id', actionsColumn: 'actions' },
        },
      }),
      policies(guard) {
        guard
          .model('Workspace')
          .policy('app_user')
          .select((p) => p.hasGrant('READER', col('id'), { table: 'workspaceId' }))
        guard
          .model('Other')
          .policy('app_user')
          // @ts-expect-error — 'bogus' is not in the declared tables keys ('workspaceId')
          .select((p) => p.hasGrant('READER', col('id'), { table: 'bogus' }))
      },
    })
    expect(materializeSchema(schema).getPolicies().length).toBeGreaterThan(0)
  })

  it('leaves the hint unconstrained (string) when there is no table source', () => {
    const guard = new Guarddog({
      claims: defineClaims({ accessor: 'x', shape: (c) => ({ sub: c.uuid() }) }),
      dbRoles: defineDbRoles({ app_user: { inherits: [] } }),
      appRoles: defineAppRoles({}),
      resources: defineResources({}),
      // no resourceGrants → TGrantTableKeys defaults to string
    })
    guard
      .model('Foo')
      .policy('app_user')
      // any string accepted when unconstrained — no narrowing, no error
      .select((p) => p.hasGrant('edit', col('id'), { table: 'anything' }))
    expect(guard.getPolicies().length).toBe(1)
  })
})
