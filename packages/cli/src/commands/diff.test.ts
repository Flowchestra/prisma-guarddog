import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resolveConfig } from '../config.js'
import { runDiff } from './diff.js'

let workDir: string
beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'guarddog-diff-'))
})
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

const SCHEMA_SOURCE = `
import {
  col,
  defineAppRoles,
  defineClaims,
  defineDbRoles,
  defineResources,
  defineSchema,
} from '@flowchestra/prisma-guarddog-core'

export default defineSchema({
  claims: defineClaims({ accessor: 'x', shape: (c) => ({ sub: c.uuid(), tenantId: c.uuid() }) }),
  dbRoles: defineDbRoles({ app_user: { inherits: [] } }),
  appRoles: defineAppRoles({}),
  resources: defineResources({ Tenant: { model: 'Tenant', id: 'id' } }),
  policies(g) {
    g.model('Workspace')
      .policy('app_user')
      .select((p) => p.claim('tenantId').eq(col('tenantId')))
  },
})
`

describe('runDiff (no prior migrations)', () => {
  it('reports pending changes against an empty migrations dir', async () => {
    const schemaPath = join(workDir, 'guarddog.ts')
    writeFileSync(schemaPath, SCHEMA_SOURCE, 'utf8')
    const migrationsDir = join(workDir, 'migrations-empty')

    const config = resolveConfig({ cwd: workDir, overrides: { schemaPath, migrationsDir } })
    const result = await runDiff({ config, stdout: false })

    expect(result.ok).toBe(true)
    expect(result.hasChanges).toBe(true)
    expect(result.ops.length).toBeGreaterThan(0)
    expect(result.sql.some((s) => s.includes('CREATE POLICY'))).toBe(true)
  })

  it('--exit-code flips ok=false when there are pending changes', async () => {
    const schemaPath = join(workDir, 'guarddog.ts')
    writeFileSync(schemaPath, SCHEMA_SOURCE, 'utf8')
    const migrationsDir = join(workDir, 'migrations-empty-2')

    const config = resolveConfig({ cwd: workDir, overrides: { schemaPath, migrationsDir } })
    const result = await runDiff({ config, exitCode: true, stdout: false })

    expect(result.hasChanges).toBe(true)
    expect(result.ok).toBe(false)
  })
})

describe('runDiff (file-not-found path)', () => {
  it('returns ok=false with a "schema file not found" diagnostic', async () => {
    const config = resolveConfig({
      cwd: workDir,
      overrides: { schemaPath: join(workDir, 'does-not-exist.ts') },
    })
    const result = await runDiff({ config, stdout: false })
    expect(result.ok).toBe(false)
    expect(result.diagnostics[0]).toMatch(/schema file not found/)
  })
})
