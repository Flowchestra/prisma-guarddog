/**
 * Existing-policy drift + cutover E2E (ADR-0029).
 *
 * Proves the adoption story end-to-end against real Postgres:
 *   1. A consumer's pre-existing legacy policy (`FOR ALL USING (true)`) leaks
 *      soft-deleted rows on SELECT — the latent bug.
 *   2. guarddog's policies are applied (with the ownership COMMENT marker) and
 *      its SELECT gates on `deleted_at IS NULL`. But because the legacy policy
 *      is permissive and ORs in, the leak SURVIVES — and `computePolicyDrift`
 *      flags the legacy policy as foreign + permissive on a managed table.
 *   3. The `--drop-unmanaged` cutover (`driftToDropOps`) drops the legacy
 *      policy. Re-running drift is clean, and the leak is gone — the role can
 *      no longer SELECT the soft-deleted row.
 *
 * Role namespaced (`drift_user`) so this runs in parallel with the other CLI
 * e2e files. Skipped unless `GUARDDOG_E2E=1` + a valid `GUARDDOG_DATABASE_URL`.
 */

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
import { assertAllowed, withScenario } from '@flowchestra/prisma-guarddog-testing-postgres'
// eslint-disable-next-line import/no-extraneous-dependencies -- pg is an optional peerDep + devDep of this package.
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { computePolicyDrift, driftToDropOps } from './drift.js'
import { renderOps } from './render-ops.js'

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

const TENANT = '00000000-0000-0000-0000-0000000df001'
const DOC_ACTIVE = '00000000-0000-0000-0000-0000000da001'
const DOC_DELETED = '00000000-0000-0000-0000-0000000da002'
const USER = '00000000-0000-0000-0000-0000000de001'

const SCHEMA_SQL = `
  CREATE TABLE drift_doc (
    id          uuid PRIMARY KEY,
    "tenantId"  uuid NOT NULL,
    title       text NOT NULL,
    deleted_at  timestamptz
  );
`

const SEED_SQL = `
  INSERT INTO drift_doc (id, "tenantId", title, deleted_at) VALUES
    ('${DOC_ACTIVE}',  '${TENANT}', 'active doc',       NULL),
    ('${DOC_DELETED}', '${TENANT}', 'soft-deleted doc', now());
`

// The consumer's pre-existing hand-written policy: FOR ALL, no deleted_at gate.
const LEGACY_SQL = `
  CREATE POLICY drift_doc_legacy_all ON drift_doc FOR ALL TO drift_user USING (true);
  ALTER TABLE drift_doc ENABLE ROW LEVEL SECURITY;
  ALTER TABLE drift_doc FORCE ROW LEVEL SECURITY;
`

const TEARDOWN_SQL = `
  DROP TABLE IF EXISTS drift_doc CASCADE;
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drift_user') THEN
      EXECUTE 'DROP OWNED BY drift_user CASCADE';
      EXECUTE 'DROP ROLE drift_user';
    END IF;
  END
  $$;
`

function buildGuard() {
  const guard = new Guarddog({
    claims: defineClaims({ accessor: 'request.jwt.claims', shape: (c) => ({ sub: c.uuid(), tenantId: c.uuid() }) }),
    dbRoles: defineDbRoles({ drift_user: { inherits: [], nologin: true } }),
    appRoles: defineAppRoles({}),
    resources: defineResources({}),
  })
  guard
    .model('DriftDoc')
    .table('drift_doc')
    .policy('drift_user')
    .select((p) => p.raw('deleted_at IS NULL'))
  return guard
}

describe.skipIf(!enabled)('existing-policy drift + cutover E2E (ADR-0029)', () => {
  let owner: Client
  const guard = buildGuard()

  beforeAll(async () => {
    owner = new Client({ connectionString: process.env['GUARDDOG_DATABASE_URL']! })
    await owner.connect()
    await owner.query(TEARDOWN_SQL)
    await owner.query(SCHEMA_SQL)
    await owner.query('CREATE ROLE drift_user NOLOGIN')
    await owner.query('GRANT SELECT ON drift_doc TO drift_user')
    await owner.query('GRANT USAGE ON SCHEMA public TO drift_user')
    await owner.query(LEGACY_SQL)
    await owner.query(SEED_SQL)

    // Apply guarddog's policies (with ownership marker) alongside the legacy one.
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

  it('flags the legacy FOR ALL policy as foreign + permissive on a managed table', async () => {
    const inventory = await readPolicyInventory(owner, { schema: 'public' })
    const drift = computePolicyDrift(compileToState(guard), inventory)
    expect(drift.managedTables).toContain('drift_doc')
    const foreign = drift.foreign.find((f) => f.policyName === 'drift_doc_legacy_all')
    expect(foreign).toBeDefined()
    expect(foreign!.permissive).toBe(true)
    // guarddog's own policy is NOT foreign (carries the ownership comment)
    expect(drift.foreign.some((f) => f.policyName === 'drift_doc_drift_user_select')).toBe(false)
  })

  it('leaks soft-deleted rows BEFORE cutover (legacy permissive policy ORs in)', async () => {
    await withScenario(owner, { role: 'drift_user', claims: { sub: USER, tenantId: TENANT } }, async (db) => {
      const result = await assertAllowed(db.query<{ id: string }>('SELECT id FROM drift_doc ORDER BY title', []))
      // both rows visible — the leak
      expect(result.rows.map((r) => r.id).toSorted()).toEqual([DOC_ACTIVE, DOC_DELETED].toSorted())
    })
  })

  it('cutover drops the legacy policy; drift goes clean and the leak is gone', async () => {
    const before = computePolicyDrift(compileToState(guard), await readPolicyInventory(owner, { schema: 'public' }))
    const dropOps = driftToDropOps(before)
    for (const stmt of renderOps(dropOps, { claims: guard.config.claims })) {
      await owner.query(stmt)
    }

    // drift is clean now
    const after = computePolicyDrift(compileToState(guard), await readPolicyInventory(owner, { schema: 'public' }))
    expect(after.foreign).toHaveLength(0)
    expect(after.ok).toBe(true)

    // and the soft-deleted row is no longer SELECTable
    await withScenario(owner, { role: 'drift_user', claims: { sub: USER, tenantId: TENANT } }, async (db) => {
      const result = await assertAllowed(db.query<{ id: string }>('SELECT id FROM drift_doc', []))
      expect(result.rows.map((r) => r.id)).toEqual([DOC_ACTIVE])
    })
  })
})
