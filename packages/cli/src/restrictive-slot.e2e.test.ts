/**
 * Named-slot restrictive E2E (ADR-0033).
 *
 * Proves that two distinct `.isolation(slot, fn)` calls on the same model
 * coexist as **two separate `pg_policies` rows** with distinct names, and
 * that both AND together when filtering — independent invariants, not one
 * combined predicate.
 *
 * Scenario:
 *   1. `gadget(id, tenant_id, deleted_at, payload)` seeded with rows across
 *      two tenants, some active and some soft-deleted.
 *   2. `.isolation('boundary', p => tenantId == claim)` — tenant scope.
 *   3. `.isolation('no_soft_deleted', p => deleted_at IS NULL)` — soft-delete floor.
 *   4. A permissive `restrictive_slot_user.select USING(true)` would
 *      otherwise expose everything.
 *   5. With JWT tenantId=A, the role sees only A's active rows. The pg_policies
 *      catalog shows two distinct restrictive rows named `gadget_boundary` and
 *      `gadget_no_soft_deleted`.
 *
 * Role-naming convention (per polymorphic-synthetic.e2e.test.ts): vitest runs
 * test files in parallel against the same DB; this file uses
 * `restrictive_slot_user` to avoid collisions with peer e2e files.
 */

import {
  col,
  compileToOps,
  defineAppRoles,
  defineClaims,
  defineDbRoles,
  defineResources,
  Guarddog,
} from '@flowchestra/prisma-guarddog-core'
import { assertAllowed, withScenario } from '@flowchestra/prisma-guarddog-testing-postgres'
// eslint-disable-next-line import/no-extraneous-dependencies -- pg is an optional peerDep + devDep of this package.
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { renderOps } from './render-ops.js'

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

const TENANT_A = '00000000-0000-0000-0000-000000008a01'
const TENANT_B = '00000000-0000-0000-0000-000000008b01'
const GADGET_A_ACTIVE = '00000000-0000-0000-0000-000000008aa1'
const GADGET_A_DELETED = '00000000-0000-0000-0000-000000008aa2'
const GADGET_B_ACTIVE = '00000000-0000-0000-0000-000000008bb1'

const SCHEMA_SQL = `
  CREATE TABLE gadget (
    id          uuid PRIMARY KEY,
    "tenantId"  uuid NOT NULL,
    "deletedAt" timestamptz NULL,
    payload     text NOT NULL
  );
`

const SEED_SQL = `
  INSERT INTO gadget (id, "tenantId", "deletedAt", payload) VALUES
    ('${GADGET_A_ACTIVE}',  '${TENANT_A}', NULL,       'tenant A active'),
    ('${GADGET_A_DELETED}', '${TENANT_A}', NOW(),      'tenant A soft-deleted'),
    ('${GADGET_B_ACTIVE}',  '${TENANT_B}', NULL,       'tenant B active');
`

const TEARDOWN_SQL = `
  DROP TABLE IF EXISTS gadget CASCADE;
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'restrictive_slot_user') THEN
      EXECUTE 'DROP OWNED BY restrictive_slot_user CASCADE';
      EXECUTE 'DROP ROLE restrictive_slot_user';
    END IF;
  END
  $$;
`

function buildGuard() {
  return new Guarddog({
    claims: defineClaims({
      accessor: 'request.jwt.claims',
      shape: (c) => ({ sub: c.uuid(), tenantId: c.uuid() }),
    }),
    dbRoles: defineDbRoles({ restrictive_slot_user: { inherits: [], nologin: true } }),
    appRoles: defineAppRoles({}),
    resources: defineResources({}),
  })
}

describe.skipIf(!enabled)('named-slot restrictive policies E2E (ADR-0033)', () => {
  let owner: Client

  beforeAll(async () => {
    owner = new Client({ connectionString: process.env['GUARDDOG_DATABASE_URL']! })
    await owner.connect()
    await owner.query(TEARDOWN_SQL)
    await owner.query(SCHEMA_SQL)

    const guard = buildGuard()
    guard
      .model('Gadget')
      // Two distinct invariants, each its own slot → two pg_policies rows.
      .isolation('boundary', (p) => p.claim('tenantId').eq(col('tenantId')))
      .isolation('no_soft_deleted', (p) => p.raw('"deletedAt" IS NULL'))
      // Permissive — would otherwise expose everything if not for the floors.
      .policy('restrictive_slot_user')
      .select((p) => p.literal(true))

    const ops = compileToOps(guard)
    const sql = renderOps(ops, { claims: guard.config.claims })
    for (const stmt of sql) {
      await owner.query(stmt)
    }
    await owner.query('GRANT SELECT ON gadget TO restrictive_slot_user')

    await owner.query(SEED_SQL)
  }, 30_000)

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.query(TEARDOWN_SQL)
      await owner.end()
    }
  })

  it('declares two distinct restrictive pg_policies rows (one per slot)', async () => {
    const result = await owner.query<{ policyname: string; permissive: boolean | string }>(
      `SELECT policyname, permissive FROM pg_policies WHERE schemaname = 'public' AND tablename = 'gadget' AND policyname IN ('gadget_boundary', 'gadget_no_soft_deleted') ORDER BY policyname`,
      []
    )
    expect(result.rows.map((r) => r.policyname)).toEqual(['gadget_boundary', 'gadget_no_soft_deleted'])
    for (const row of result.rows) {
      expect(row.permissive === 'RESTRICTIVE' || row.permissive === false).toBe(true)
    }
  })

  it("a role with JWT tenantId=A sees ONLY the active tenant-A row (both floors AND'd)", async () => {
    await withScenario(
      owner,
      { role: 'restrictive_slot_user', claims: { sub: '00000000-0000-0000-0000-000000000001', tenantId: TENANT_A } },
      async (db) => {
        const result = await assertAllowed(db.query<{ id: string }>('SELECT id FROM gadget ORDER BY id', []))
        expect(result.rows.map((r) => r.id)).toEqual([GADGET_A_ACTIVE])
      }
    )
  })

  it('a role with JWT tenantId=B sees ONLY the active tenant-B row', async () => {
    await withScenario(
      owner,
      { role: 'restrictive_slot_user', claims: { sub: '00000000-0000-0000-0000-000000000002', tenantId: TENANT_B } },
      async (db) => {
        const result = await assertAllowed(db.query<{ id: string }>('SELECT id FROM gadget ORDER BY id', []))
        expect(result.rows.map((r) => r.id)).toEqual([GADGET_B_ACTIVE])
      }
    )
  })
})
