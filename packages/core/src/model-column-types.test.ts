/**
 * Type-level tests for typed `model()` + `p.col()` (#ADR-0028).
 *
 * The `@ts-expect-error` lines are the assertions: they pass type-check ONLY
 * if the model + column unions flow from `defineSchema({ models })` →
 * `Guarddog` → `model()` → the predicate builder. If `TModels`/`TColumns`
 * silently widened to `string`, the directives would become "unused" and
 * tsgo would fail. A green tsgo on this file proves the autocomplete + the
 * `ModelColumns`-const inference are wired.
 */

import { describe, expect, it } from 'vitest'

import { defineAppRoles } from './app-roles.js'
import { defineClaims } from './claims.js'
import { defineDbRoles } from './db-roles.js'
import { Guarddog } from './guarddog.js'
import { col } from './predicate.js'
import { defineResources } from './resources.js'
import { defineSchema, materializeSchema } from './schema.js'

// Simulates the generated `ModelColumns` const (DMMF dbName tuples).
const ModelColumns = {
  Workspace: ['id', 'tenantId', 'name'],
  Workbench: ['id', 'workspaceId', 'ownerId'],
} as const

const base = {
  claims: defineClaims({ accessor: 'request.jwt.claims', shape: (c) => ({ sub: c.uuid(), tenantId: c.uuid() }) }),
  dbRoles: defineDbRoles({ app_user: { inherits: [], nologin: true } }),
  appRoles: defineAppRoles({}),
  resources: defineResources({}),
}

describe('typed model() + p.col() inference (ADR-0028)', () => {
  it('infers model names + column unions from the models const', () => {
    const schema = defineSchema({
      ...base,
      models: ModelColumns,
      policies(guard) {
        guard
          .model('Workspace')
          .policy('app_user')
          .select((p) => p.col('tenantId').eq(p.claim('tenantId')))

        guard
          .model('Workbench')
          .policy('app_user')
          // @ts-expect-error — 'ghost' is not a column of Workbench
          .select((p) => p.col('ghost').eq(p.claim('sub')))

        guard
          .model('Workspace')
          .policy('app_user')
          // @ts-expect-error — 'workspaceId' belongs to Workbench, not Workspace
          .insert({ check: (p) => p.col('workspaceId').eq(p.claim('sub')) })
      },
    })
    expect(materializeSchema(schema).getPolicies().length).toBeGreaterThan(0)
  })

  it('rejects an unknown model name', () => {
    defineSchema({
      ...base,
      models: ModelColumns,
      policies(guard) {
        // @ts-expect-error — 'Ghost' is not a declared model
        guard.model('Ghost')
      },
    })
    expect(true).toBe(true)
  })

  it('still allows the standalone col() escape hatch under a typed schema', () => {
    const schema = defineSchema({
      ...base,
      models: ModelColumns,
      policies(guard) {
        // raw col() is unconstrained — for dynamic / non-modeled columns
        guard
          .model('Workspace')
          .policy('app_user')
          .select((p) => p.claim('tenantId').eq(col('whatever_raw_column')))
      },
    })
    expect(materializeSchema(schema).getPolicies()).toHaveLength(1)
  })

  it('leaves model()/p.col() unconstrained (string) when no models map is supplied', () => {
    const guard = new Guarddog({
      claims: defineClaims({ accessor: 'x', shape: (c) => ({ sub: c.uuid() }) }),
      dbRoles: defineDbRoles({ app_user: { inherits: [] } }),
      appRoles: defineAppRoles({}),
      resources: defineResources({}),
    })
    // any string accepted — no narrowing, no error
    guard
      .model('AnyModel')
      .policy('app_user')
      .select((p) => p.col('any_column').eq(p.claim('sub')))
    expect(guard.getPolicies()).toHaveLength(1)
  })
})
