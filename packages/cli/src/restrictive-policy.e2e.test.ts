/**
 * Restrictive policy E2E (ADR-0032).
 *
 * Proves that a `.isolation(...)` (restrictive `FOR ALL`) floor is inescapable
 * even when a permissive break-glass policy says `USING (true)` for the same
 * role. The point of the ADR is that Postgres AND's restrictives with every
 * other policy, so the floor cannot be widened-around.
 *
 * Scenario:
 *   1. `widget(id, tenant_id, payload)` seeded with rows for two tenants.
 *   2. `.isolation((p) => p.claim('tenantId').eq(col('tenantId')))` on the
 *      model — emits `AS RESTRICTIVE FOR ALL TO public USING (tenant scope)
 *      WITH CHECK (tenant scope)`.
 *   3. `restrictive_e2e_user` has a permissive `SELECT USING (true)` that
 *      would otherwise let it see everything.
 *   4. With JWT `tenantId=A`, the role sees only A's row. With `tenantId=B`,
 *      only B's row. The permissive's `true` cannot escape the restrictive.
 *
 * Skipped unless `GUARDDOG_E2E=1` + `GUARDDOG_DATABASE_URL` are set.
 *
 * Role naming convention (per polymorphic-synthetic.e2e.test.ts): vitest runs
 * test files in parallel against the same DB; we use `restrictive_e2e_user`
 * to avoid collision with peers.
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

const TENANT_A = '00000000-0000-0000-0000-000000007a01'
const TENANT_B = '00000000-0000-0000-0000-000000007b01'
const WIDGET_A = '00000000-0000-0000-0000-000000007aaa'
const WIDGET_B = '00000000-0000-0000-0000-000000007bbb'

const SCHEMA_SQL = `
  CREATE TABLE widget (
    id         uuid PRIMARY KEY,
    "tenantId" uuid NOT NULL,
    payload    text NOT NULL
  );
`

const SEED_SQL = `
  INSERT INTO widget (id, "tenantId", payload) VALUES
    ('${WIDGET_A}', '${TENANT_A}', 'tenant A widget'),
    ('${WIDGET_B}', '${TENANT_B}', 'tenant B widget');
`

const TEARDOWN_SQL = `
  DROP TABLE IF EXISTS widget CASCADE;
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'restrictive_e2e_user') THEN
      EXECUTE 'DROP OWNED BY restrictive_e2e_user CASCADE';
      EXECUTE 'DROP ROLE restrictive_e2e_user';
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
    dbRoles: defineDbRoles({ restrictive_e2e_user: { inherits: [], nologin: true } }),
    appRoles: defineAppRoles({}),
    resources: defineResources({}),
  })
}

describe.skipIf(!enabled)('restrictive isolation policy E2E (ADR-0032)', () => {
  let owner: Client

  beforeAll(async () => {
    owner = new Client({ connectionString: process.env['GUARDDOG_DATABASE_URL']! })
    await owner.connect()
    await owner.query(TEARDOWN_SQL)
    await owner.query(SCHEMA_SQL)

    const guard = buildGuard()
    guard
      .model('Widget')
      // Restrictive isolation floor — tenant scoping, applies to ALL commands.
      .isolation((p) => p.claim('tenantId').eq(col('tenantId')))
      // Permissive break-glass — would let the role see everything if it
      // weren't AND'd with the restrictive floor.
      .policy('restrictive_e2e_user')
      .select((p) => p.literal(true))

    const ops = compileToOps(guard)
    const sql = renderOps(ops, { claims: guard.config.claims })
    for (const stmt of sql) {
      await owner.query(stmt)
    }
    await owner.query('GRANT SELECT ON widget TO restrictive_e2e_user')

    await owner.query(SEED_SQL)
  }, 30_000)

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.query(TEARDOWN_SQL)
      await owner.end()
    }
  })

  it("a role with JWT tenantId=A sees ONLY tenant A's row, despite USING(true)", async () => {
    await withScenario(
      owner,
      { role: 'restrictive_e2e_user', claims: { sub: '00000000-0000-0000-0000-000000000001', tenantId: TENANT_A } },
      async (db) => {
        const result = await assertAllowed(
          db.query<{ id: string; tenantId: string }>('SELECT id, "tenantId" FROM widget ORDER BY id', [])
        )
        expect(result.rows.map((r) => r.id)).toEqual([WIDGET_A])
      }
    )
  })

  it("a role with JWT tenantId=B sees ONLY tenant B's row", async () => {
    await withScenario(
      owner,
      { role: 'restrictive_e2e_user', claims: { sub: '00000000-0000-0000-0000-000000000002', tenantId: TENANT_B } },
      async (db) => {
        const result = await assertAllowed(
          db.query<{ id: string; tenantId: string }>('SELECT id, "tenantId" FROM widget ORDER BY id', [])
        )
        expect(result.rows.map((r) => r.id)).toEqual([WIDGET_B])
      }
    )
  })

  it('pg_policies records the restrictive policy as permissive=false (proves AS RESTRICTIVE landed)', async () => {
    const result = await owner.query<{ permissive: boolean | string }>(
      `SELECT permissive FROM pg_policies WHERE schemaname = 'public' AND tablename = 'widget' AND policyname = 'widget_isolation'`,
      []
    )
    expect(result.rows).toHaveLength(1)
    // pg_policies.permissive is text in older pg versions, boolean in newer.
    const live = result.rows[0]!.permissive
    expect(live === 'RESTRICTIVE' || live === false).toBe(true)
  })

  it('the coexisting permissive policy is still permissive (proves we did not flip everything)', async () => {
    const result = await owner.query<{ permissive: boolean | string }>(
      `SELECT permissive FROM pg_policies WHERE schemaname = 'public' AND tablename = 'widget' AND policyname = 'widget_restrictive_e2e_user_select'`,
      []
    )
    expect(result.rows).toHaveLength(1)
    const live = result.rows[0]!.permissive
    expect(live === 'PERMISSIVE' || live === true).toBe(true)
  })
})
