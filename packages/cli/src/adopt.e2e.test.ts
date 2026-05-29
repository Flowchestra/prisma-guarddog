/**
 * Interactive adoption triage E2E (ADR-0030).
 *
 * Drives `runAdopt` with a scripted `decide` (keep / remove / edit) over three
 * pre-existing legacy policies on a guarddog-managed table, and verifies the
 * DB-affecting dispositions land:
 *   - keep   → the policy is stamped `:ignore` (drift now reports it as
 *              acknowledged, not foreign).
 *   - remove → the policy is dropped.
 *   - edit   → the policy is left in place and a rawSql+todo scaffold is emitted.
 *
 * Role/table namespaced (`adopt_user` / `adopt_doc`) for parallel safety.
 * Skipped unless `GUARDDOG_E2E=1` + a valid `GUARDDOG_DATABASE_URL`.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  compileToOps,
  compileToState,
  defineAppRoles,
  defineClaims,
  defineDbRoles,
  defineResources,
  Guarddog,
} from '@flowchestra/prisma-guarddog-core'
import { readPolicyInventory } from '@flowchestra/prisma-guarddog-importer-postgres'
// eslint-disable-next-line import/no-extraneous-dependencies -- pg is an optional peerDep + devDep of this package.
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runAdopt } from './commands/adopt.js'
import { type AdoptionDisposition, computePolicyDrift, type ForeignPolicy } from './drift.js'
import { GUARDDOG_IGNORE_COMMENT, renderOps } from './render-ops.js'

function e2eEnabled(): boolean {
  if (process.env['GUARDDOG_E2E'] !== '1') return false
  const url = process.env['GUARDDOG_DATABASE_URL']
  if (typeof url !== 'string') return false
  try {
    const u = new URL(url)
    return u.protocol === 'postgres:' || u.protocol === 'postgresql:'
  } catch {
    return false
  }
}

const enabled = e2eEnabled()

const SCHEMA_SQL = `
  CREATE TABLE adopt_doc (
    id          uuid PRIMARY KEY,
    "tenantId"  uuid NOT NULL,
    deleted_at  timestamptz
  );
`
// Three pre-existing hand-written policies, all foreign to guarddog.
const LEGACY_SQL = `
  CREATE POLICY adopt_doc_keep   ON adopt_doc FOR ALL    TO adopt_user USING (true);
  CREATE POLICY adopt_doc_remove ON adopt_doc FOR ALL    TO adopt_user USING (true);
  CREATE POLICY adopt_doc_edit   ON adopt_doc FOR SELECT TO adopt_user USING ("tenantId" IS NOT NULL);
  ALTER TABLE adopt_doc ENABLE ROW LEVEL SECURITY;
  ALTER TABLE adopt_doc FORCE ROW LEVEL SECURITY;
`
const TEARDOWN_SQL = `
  DROP TABLE IF EXISTS adopt_doc CASCADE;
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'adopt_user') THEN
      EXECUTE 'DROP OWNED BY adopt_user CASCADE';
      EXECUTE 'DROP ROLE adopt_user';
    END IF;
  END
  $$;
`

function buildGuard() {
  const guard = new Guarddog({
    claims: defineClaims({ accessor: 'request.jwt.claims', shape: (c) => ({ sub: c.uuid(), tenantId: c.uuid() }) }),
    dbRoles: defineDbRoles({ adopt_user: { inherits: [], nologin: true } }),
    appRoles: defineAppRoles({}),
    resources: defineResources({}),
  })
  guard
    .model('AdoptDoc')
    .table('adopt_doc')
    .policy('adopt_user')
    .select((p) => p.raw('deleted_at IS NULL'))
  return guard
}

// A temp guarddog.ts equivalent to buildGuard(), so runAdopt's loadSchema has
// a real file to materialize (it loads via config.schemaPath, not an injected
// guard).
function writeSchemaFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'guarddog-adopt-'))
  const file = join(dir, 'guarddog.ts')
  writeFileSync(
    file,
    `
import { defineSchema, defineClaims, defineDbRoles, defineAppRoles, defineResources } from '@flowchestra/prisma-guarddog-core'
export default defineSchema({
  claims: defineClaims({ accessor: 'request.jwt.claims', shape: (c) => ({ sub: c.uuid(), tenantId: c.uuid() }) }),
  dbRoles: defineDbRoles({ adopt_user: { inherits: [], nologin: true } }),
  appRoles: defineAppRoles({}),
  resources: defineResources({}),
  policies(guard) {
    guard.model('AdoptDoc').table('adopt_doc').policy('adopt_user').select((p) => p.raw('deleted_at IS NULL'))
  },
})
`,
    'utf8'
  )
  return file
}

const DISPOSITIONS: Readonly<Record<string, AdoptionDisposition>> = {
  adopt_doc_keep: 'keep',
  adopt_doc_remove: 'remove',
  adopt_doc_edit: 'edit',
}
const scriptedDecide = (foreign: ReadonlyArray<ForeignPolicy>): ReadonlyMap<string, AdoptionDisposition> =>
  new Map(foreign.map((f) => [`${f.table}::${f.policyName}`, DISPOSITIONS[f.policyName] ?? 'skip']))

describe.skipIf(!enabled)('adoption triage E2E (ADR-0030)', () => {
  let owner: Client
  const guard = buildGuard()
  const schemaPath = writeSchemaFile()

  beforeAll(async () => {
    owner = new Client({ connectionString: process.env['GUARDDOG_DATABASE_URL']! })
    await owner.connect()
    await owner.query(TEARDOWN_SQL)
    await owner.query(SCHEMA_SQL)
    await owner.query('CREATE ROLE adopt_user NOLOGIN')
    await owner.query('GRANT SELECT ON adopt_doc TO adopt_user')
    await owner.query('GRANT USAGE ON SCHEMA public TO adopt_user')
    await owner.query(LEGACY_SQL)
    for (const stmt of renderOps(compileToOps(guard), { claims: guard.config.claims })) {
      await owner.query(stmt)
    }
  }, 30_000)

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.query(TEARDOWN_SQL)
      await owner.end()
    }
  })

  it('applies keep / remove / edit dispositions to the live database', async () => {
    const result = await runAdopt({
      config: {
        cwd: process.cwd(),
        schemaPath,
        prismaSchemaPath: join(tmpdir(), 'schema.prisma'),
        migrationsDir: join(tmpdir(), 'guarddog-adopt-nope'),
        metadataExt: '.guarddog.json',
        renderOverrides: {},
      },
      url: process.env['GUARDDOG_DATABASE_URL']!,
      stderr: false,
      decide: scriptedDecide,
    })

    expect(result.ok).toBe(true)
    expect(result.plan!.keep.map((k) => k.policyName)).toEqual(['adopt_doc_keep'])
    expect(result.plan!.dropOps).toEqual([{ kind: 'drop-policy', table: 'adopt_doc', name: 'adopt_doc_remove' }])
    expect(result.plan!.editRows.map((r) => r.policyName)).toEqual(['adopt_doc_edit'])
    // scaffold carries the edited policy as reviewable rawSql + todo
    expect(result.scaffold).toMatch(/rawSql/)
    expect(result.scaffold).toContain('adopt_doc_edit')

    // DB reflects the dispositions:
    const inventory = await readPolicyInventory(owner, { schema: 'public' })
    const byName = new Map(inventory.map((p) => [p.policyName, p] as const))
    expect(byName.get('adopt_doc_keep')?.comment).toBe(GUARDDOG_IGNORE_COMMENT) // kept → acknowledged
    expect(byName.has('adopt_doc_remove')).toBe(false) // removed → dropped
    expect(byName.has('adopt_doc_edit')).toBe(true) // edit → left in place (scaffolded)

    // and drift now classifies kept as acknowledged, edit still foreign
    const drift = computePolicyDrift(compileToState(guard), inventory)
    expect(drift.acknowledged.map((a) => a.policyName)).toContain('adopt_doc_keep')
    expect(drift.foreign.map((f) => f.policyName)).toContain('adopt_doc_edit')
    expect(drift.foreign.map((f) => f.policyName)).not.toContain('adopt_doc_keep')
  })
})
