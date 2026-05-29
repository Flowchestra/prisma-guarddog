/**
 * Regression: a policy calling a multi-arg managed function (`p.fn`) must emit
 * through the full CLI path (jiti `loadSchema` → `planMigrate` → `renderOps`).
 *
 * Guards #19: `p.fn` arguments were discriminated with `instanceof FluentExpr`,
 * which is false across the jiti/CLI module-instance boundary, so a `col(...)`
 * arg got mis-wrapped as a literal and crashed in `formatLiteral`. This test
 * exercises that exact boundary by loading a real schema file via jiti.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { runEmit } from './commands/emit.js'

function writeSchema(): string {
  const dir = mkdtempSync(join(tmpdir(), 'guarddog-fn-cli-'))
  const file = join(dir, 'guarddog.ts')
  writeFileSync(
    file,
    `
import {
  defineSchema, defineClaims, defineDbRoles, defineAppRoles, defineResources, defineFunctions, col,
} from '@flowchestra/prisma-guarddog-core'

export default defineSchema({
  claims: defineClaims({ accessor: 'request.jwt.claims', shape: (c) => ({ sub: c.uuid(), tenant_id: c.uuid() }) }),
  dbRoles: defineDbRoles({ app_user: { inherits: [], nologin: true } }),
  appRoles: defineAppRoles({}),
  resources: defineResources({}),
  functions: defineFunctions({
    schema: 'app',
    fns: {
      current_tenant_id: { args: [], returns: 'uuid', volatility: 'stable', body: 'SELECT NULL::uuid' },
      user_has_workspace_grant: {
        args: [
          { name: 'workspace_id_in', type: 'text' },
          { name: 'user_id_in', type: 'text' },
          { name: 'min_role_in', type: 'text', default: 'NULL' },
        ],
        returns: 'boolean', volatility: 'stable', security: 'definer',
        searchPath: ['pg_catalog', 'public'],
        grants: { execute: ['app_user'] }, body: 'SELECT true',
      },
    },
  }),
  policies(guard) {
    // zero-arg call (always worked) + multi-arg call (the #19 repro)
    guard.model('Workspace').table('workspaces').policy('app_user')
      .select((p) =>
        p.fn('current_tenant_id').eq(col('tenant_id'))
          .and(p.fn('user_has_workspace_grant', col('id'), col('id'), 'MANAGER')))
  },
})
`,
    'utf8'
  )
  return file
}

describe('managed functions via the CLI (jiti) path', () => {
  it('emits a policy that calls a multi-arg managed function (regression #19)', async () => {
    const schemaPath = writeSchema()
    const result = await runEmit({
      config: {
        cwd: tmpdir(),
        schemaPath,
        prismaSchemaPath: join(tmpdir(), 'schema.prisma'),
        migrationsDir: join(tmpdir(), 'guarddog-fn-cli-nope'),
        metadataExt: '.guarddog.json',
        renderOverrides: {},
      },
      stderr: false,
    })
    expect(result.ok).toBe(true)
    const policySql = result.sql.find((s) => s.startsWith('CREATE POLICY'))
    expect(policySql).toBeDefined()
    // args compiled as real expressions, not coerced through formatLiteral
    expect(policySql).toContain('app.user_has_workspace_grant(id, id, ')
    expect(policySql).toContain("'MANAGER'")
    expect(policySql).toContain('app.current_tenant_id() = tenant_id')
  })
})
