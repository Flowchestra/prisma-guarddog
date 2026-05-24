/**
 * Importer round-trip E2E — issue 1.4-A.
 *
 * Validates the entire "adopt guarddog into an existing project" loop:
 *
 *   1. Real Postgres database with a hand-written RLS policy.
 *   2. `runImport` reads `pg_policies` + column privileges and generates
 *      a TypeScript scaffold (rawSql() + .todo() stubs).
 *   3. Wrap the scaffold in a `defineSchema(...)` boilerplate (this is
 *      what the README tells users to do — paste the importedPolicies
 *      function into their existing schema).
 *   4. `loadSchema` loads + materializes the combined module.
 *   5. The resulting Guarddog has a policy registered for the imported
 *      table.
 *
 * Skipped unless `GUARDDOG_E2E=1` + `GUARDDOG_DATABASE_URL` are set.
 * Pure scaffold-generation tests live in importer-postgres; this is the
 * loop-closure proof that ADR-0012 promises.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// eslint-disable-next-line import/no-extraneous-dependencies -- pg is an optional peerDep + devDep of @flowchestra/prisma-guarddog.
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runImport } from './commands/import.js'
import { loadSchema } from './load.js'

function e2eEnabled(): boolean {
  if (process.env['GUARDDOG_E2E'] !== '1') return false
  const url = process.env['GUARDDOG_DATABASE_URL']
  if (typeof url !== 'string') return false
  try {
    const u = new URL(url)
    if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
      console.warn(`GUARDDOG_DATABASE_URL is not a postgres:// URL (got "${u.protocol}"); skipping E2E`)
      return false
    }
    return true
  } catch {
    console.warn(`GUARDDOG_DATABASE_URL is not a valid URL (got "${url}"); skipping E2E`)
    return false
  }
}

const enabled = e2eEnabled()

const FIXTURE_TABLE_SQL = `
  CREATE TABLE roundtrip_widget (
    id          uuid PRIMARY KEY,
    "tenantId"  uuid NOT NULL,
    name        text NOT NULL
  );
  -- Hand-written role + policy. The importer should detect both.
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'roundtrip_user') THEN
      CREATE ROLE roundtrip_user NOLOGIN;
    END IF;
  END $$;
  ALTER TABLE roundtrip_widget ENABLE ROW LEVEL SECURITY;
  CREATE POLICY roundtrip_widget_select ON roundtrip_widget
    FOR SELECT TO roundtrip_user
    USING ("tenantId"::text = current_setting('request.jwt.tenant', true));
`

const FIXTURE_TEARDOWN_SQL = `
  DROP TABLE IF EXISTS roundtrip_widget CASCADE;
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'roundtrip_user') THEN
      EXECUTE 'DROP OWNED BY roundtrip_user CASCADE';
      EXECUTE 'DROP ROLE roundtrip_user';
    END IF;
  END $$;
`

describe.skipIf(!enabled)('importer round-trip E2E (issue 1.4-A)', () => {
  let owner: Client
  let workDir: string

  beforeAll(async () => {
    owner = new Client({ connectionString: process.env['GUARDDOG_DATABASE_URL']! })
    await owner.connect()
    await owner.query(FIXTURE_TEARDOWN_SQL)
    await owner.query(FIXTURE_TABLE_SQL)
    workDir = mkdtempSync(join(tmpdir(), 'guarddog-roundtrip-'))
  }, 30_000)

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.query(FIXTURE_TEARDOWN_SQL)
      await owner.end()
    }
    if (workDir !== undefined) {
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  it('real PG -> importer -> loadSchema -> Guarddog has the imported policy', async () => {
    const scaffoldPath = join(workDir, 'imported.generated.ts')

    // 1. Run the importer against the live DB.
    const importResult = await runImport({
      url: process.env['GUARDDOG_DATABASE_URL']!,
      out: scaffoldPath,
      stderr: false,
    })
    expect(importResult.ok).toBe(true)
    expect(importResult.policyRowCount).toBeGreaterThan(0)

    const scaffold = readFileSync(scaffoldPath, 'utf8')
    expect(scaffold).toContain('importedPolicies')
    expect(scaffold).toContain('rawSql(')
    expect(scaffold).toContain('.todo(')
    expect(scaffold).toContain('roundtrip') // table name preserved via heuristic

    // 2. Wrap the scaffold in a `defineSchema(...)` — exactly what the
    //    README tells consumers to do. The scaffold exports
    //    `importedPolicies(guard)` and we hand it the runtime guard
    //    from the policies callback.
    const wrapped = `
import { defineAppRoles, defineClaims, defineDbRoles, defineResources, defineSchema } from '@flowchestra/prisma-guarddog-core'
import { importedPolicies } from './imported.generated.js'

export default defineSchema({
  claims: defineClaims({ accessor: 'request.jwt.claims', shape: (c) => ({ sub: c.uuid() }) }),
  dbRoles: defineDbRoles({ roundtrip_user: { inherits: [], nologin: true } }),
  appRoles: defineAppRoles({}),
  resources: defineResources({}),
  policies(guard) {
    importedPolicies(guard)
  },
})
`
    const schemaPath = join(workDir, 'guarddog.ts')
    writeFileSync(schemaPath, wrapped, 'utf8')

    // 3. Load via the CLI's loadSchema — same path `guarddog migrate` uses.
    const loaded = await loadSchema(schemaPath)
    expect(loaded.guard.getPolicies().length).toBeGreaterThan(0)

    // 4. The loaded Guarddog must carry a policy whose model resolves from
    //    the imported table name (`roundtrip_widget` → `RoundtripWidget`).
    const policies = loaded.guard.getPolicies()
    const widgetPolicy = policies.find((p) => p.model === 'RoundtripWidget')
    expect(widgetPolicy).toBeDefined()
    expect(widgetPolicy!.dbRole).toBe('roundtrip_user')
    // Importer marks every imported policy with at least one .todo().
    expect(widgetPolicy!.todos.length).toBeGreaterThan(0)
  }, 30_000)
})
