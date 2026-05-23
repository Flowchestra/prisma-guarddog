import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  defineAppRoles,
  defineClaims,
  defineDbRoles,
  defineResources,
  defineSchema,
  materializeSchema,
} from '@prisma-guarddog/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resolveConfig } from '../config.js'
import { inspectGuard, runCheck } from './check.js'

let workDir: string
beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'guarddog-check-'))
})
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('inspectGuard (pure)', () => {
  it('returns ok=true with non-zero policyCount for a Guarddog with a policy', () => {
    const guard = materializeSchema(
      defineSchema({
        claims: defineClaims({ accessor: 'x', shape: (c) => ({ sub: c.uuid() }) }),
        dbRoles: defineDbRoles({ app_user: { inherits: [] } }),
        appRoles: defineAppRoles({}),
        resources: defineResources({}),
        policies(g) {
          g.model('Foo')
            .policy('app_user')
            .select((p) => p.literal(true))
        },
      })
    )
    const result = inspectGuard('/x/guarddog.ts', guard)
    expect(result.ok).toBe(true)
    expect(result.policyCount).toBe(1)
    expect(result.polymorphicCount).toBe(0)
    expect(result.noPolicyCount).toBe(0)
    expect(result.diagnostics).toEqual([])
  })

  it('counts polymorphics and noPolicy declarations as covered content', () => {
    const guard = materializeSchema(
      defineSchema({
        claims: defineClaims({ accessor: 'x', shape: (c) => ({ sub: c.uuid() }) }),
        dbRoles: defineDbRoles({ app_user: { inherits: [] } }),
        appRoles: defineAppRoles({}),
        resources: defineResources({}),
        policies(g) {
          g.polymorphic('Scope', { discriminator: 'kind' })
            .target('A', { model: 'A' })
            .policy('app_user')
            .select((p) => p.literal(true))
          g.noPolicy('System', { reason: 'system-only' })
        },
      })
    )
    const result = inspectGuard('/x/guarddog.ts', guard)
    expect(result.ok).toBe(true)
    expect(result.policyCount).toBe(0)
    expect(result.polymorphicCount).toBe(1)
    expect(result.noPolicyCount).toBe(1)
  })

  it('reports a diagnostic when the Guarddog has no declarations', () => {
    const guard = materializeSchema(
      defineSchema({
        claims: defineClaims({ accessor: 'x', shape: (c) => ({ sub: c.uuid() }) }),
        dbRoles: defineDbRoles({ app_user: { inherits: [] } }),
        appRoles: defineAppRoles({}),
        resources: defineResources({}),
        policies: () => {},
      })
    )
    const result = inspectGuard('/x/guarddog.ts', guard)
    expect(result.ok).toBe(false)
    expect(result.diagnostics[0]).toMatch(/no policies, polymorphics, or noPolicy/)
  })

  it('returns a frozen value', () => {
    const guard = materializeSchema(
      defineSchema({
        claims: defineClaims({ accessor: 'x', shape: (c) => ({ sub: c.uuid() }) }),
        dbRoles: defineDbRoles({ app_user: { inherits: [] } }),
        appRoles: defineAppRoles({}),
        resources: defineResources({}),
        policies(g) {
          g.model('Foo')
            .policy('app_user')
            .select((p) => p.literal(true))
        },
      })
    )
    const result = inspectGuard('/x/guarddog.ts', guard)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.diagnostics)).toBe(true)
  })

  it('counts column-privilege declarations', () => {
    const guard = materializeSchema(
      defineSchema({
        claims: defineClaims({ accessor: 'x', shape: (c) => ({ sub: c.uuid() }) }),
        dbRoles: defineDbRoles({ app_user: { inherits: [] } }),
        appRoles: defineAppRoles({}),
        resources: defineResources({}),
        policies(g) {
          g.model('Foo')
            .columnPrivileges({ apiKey: { select: ['app_user'] } })
            .policy('app_user')
            .select((p) => p.literal(true))
        },
      })
    )
    const result = inspectGuard('/x/guarddog.ts', guard)
    expect(result.columnPrivilegeCount).toBe(1)
  })
})

describe('runCheck (file-not-found path)', () => {
  it('returns ok=false with a "schema file not found" diagnostic', async () => {
    const config = resolveConfig({
      cwd: workDir,
      overrides: { schemaPath: join(workDir, 'does-not-exist.ts') },
    })
    const result = await runCheck({ config, stdout: false })
    expect(result.ok).toBe(false)
    expect(result.diagnostics[0]).toMatch(/schema file not found/)
  })
})
