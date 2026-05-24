import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resolveConfig } from '../config.js'
import { runEmit } from './emit.js'

let workDir: string
beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'guarddog-emit-'))
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

describe('runEmit (file-not-found path)', () => {
  it('returns ok=false with a "schema file not found" diagnostic', async () => {
    const config = resolveConfig({
      cwd: workDir,
      overrides: { schemaPath: join(workDir, 'does-not-exist.ts') },
    })
    const result = await runEmit({ config, stderr: false })
    expect(result.ok).toBe(false)
    expect(result.diagnostics[0]).toMatch(/schema file not found/)
  })
})

describe('runEmit (happy path, --out)', () => {
  it('writes the rendered SQL to the --out file with a banner', async () => {
    const schemaPath = join(workDir, 'guarddog.ts')
    writeFileSync(schemaPath, SCHEMA_SOURCE, 'utf8')
    const outPath = join(workDir, 'emitted.sql')

    const config = resolveConfig({ cwd: workDir, overrides: { schemaPath } })
    const result = await runEmit({ config, out: outPath, stderr: false })

    expect(result.diagnostics).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.outPath).toBe(outPath)
    expect(result.ops.length).toBeGreaterThan(0)
    expect(result.sql.length).toBeGreaterThan(0)

    const written = readFileSync(outPath, 'utf8')
    expect(written).toContain('ad-hoc emit')
    expect(written).toContain('CREATE POLICY')
    expect(written).toContain('ENABLE ROW LEVEL SECURITY')
  })
})
