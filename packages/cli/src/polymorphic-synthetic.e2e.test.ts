/**
 * Synthetic polymorphic E2E — issue 1.3-B complement.
 *
 * The flowchestra example exercises polymorphic Comment alongside the
 * other six scenarios. This file is a self-contained second proof: one
 * polymorphic discriminator, two targets, the smallest fixture that can
 * verify the compile → render → apply → enforce path. Catches bugs the
 * unit-only `polymorphic.test.ts` can't (emitter quirks, SQL escaping
 * around the discriminator-equality prefix, role + GRANT interactions).
 *
 * Lives in the CLI package (not testing-postgres) because it needs
 * `renderOps` — a CLI-package export. Putting it here keeps the package
 * graph clean: no reverse arrow from testing-postgres -> CLI.
 *
 * Skipped unless `GUARDDOG_E2E=1` + `GUARDDOG_DATABASE_URL` are set.
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

const TENANT = '00000000-0000-0000-0000-000000007777'
const ALPHA_ID = '00000000-0000-0000-0000-00000000aaaa'
const BETA_ID = '00000000-0000-0000-0000-00000000bbbb'
const ATTACH_TO_ALPHA = '00000000-0000-0000-0000-00000000a1a1'
const ATTACH_TO_BETA = '00000000-0000-0000-0000-00000000b1b1'

const SCHEMA_SQL = `
  CREATE TABLE poly_alpha (id uuid PRIMARY KEY, "tenantId" uuid NOT NULL, label text NOT NULL);
  CREATE TABLE poly_beta  (id uuid PRIMARY KEY, "tenantId" uuid NOT NULL, label text NOT NULL);
  CREATE TABLE poly_attachment (
    id            uuid PRIMARY KEY,
    "tenantId"    uuid NOT NULL,
    "targetType"  text NOT NULL,
    "targetId"    uuid NOT NULL,
    body          text NOT NULL
  );
`

// UUIDs inlined — pg's parameterized protocol rejects multi-statement
// queries, so we trade `$N` placeholders for direct interpolation of the
// typed constants above. No user input flows in.
const SEED_SQL = `
  INSERT INTO poly_alpha (id, "tenantId", label) VALUES ('${ALPHA_ID}', '${TENANT}', 'alpha');
  INSERT INTO poly_beta  (id, "tenantId", label) VALUES ('${BETA_ID}',  '${TENANT}', 'beta');
  INSERT INTO poly_attachment (id, "tenantId", "targetType", "targetId", body) VALUES
    ('${ATTACH_TO_ALPHA}', '${TENANT}', 'Alpha', '${ALPHA_ID}', 'on-alpha'),
    ('${ATTACH_TO_BETA}',  '${TENANT}', 'Beta',  '${BETA_ID}',  'on-beta');
`

const TEARDOWN_SQL = `
  DROP TABLE IF EXISTS poly_attachment, poly_beta, poly_alpha CASCADE;
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'poly_user') THEN
      EXECUTE 'DROP OWNED BY poly_user CASCADE';
      EXECUTE 'DROP ROLE poly_user';
    END IF;
  END
  $$;
`

function buildSyntheticGuard() {
  const guard = new Guarddog({
    claims: defineClaims({
      accessor: 'request.jwt.claims',
      shape: (c) => ({
        sub: c.uuid(),
        tenantId: c.uuid(),
        // For Beta: a user only sees Beta-attachments if their claim grants
        // them this Beta. (Synthetic — narrower than the flowchestra one.)
        betaGrants: c.array(c.uuid()),
      }),
    }),
    dbRoles: defineDbRoles({ poly_user: { inherits: [], nologin: true } }),
    appRoles: defineAppRoles({}),
    resources: defineResources({}),
  })

  const poly = guard.polymorphic('Attachment', { discriminator: 'targetType' }).table('poly_attachment')

  poly
    .target('Alpha', { model: 'Alpha' })
    .policy('poly_user')
    .select((p) => p.claim('tenantId').eq(col('tenantId')))

  poly
    .target('Beta', { model: 'Beta' })
    .policy('poly_user')
    .select((p) =>
      p
        .claim('tenantId')
        .eq(col('tenantId'))
        .and(p.inArray(col('targetId'), p.claim('betaGrants')))
    )

  return guard
}

describe.skipIf(!enabled)('synthetic polymorphic E2E (issue 1.3-B)', () => {
  let owner: Client

  beforeAll(async () => {
    owner = new Client({ connectionString: process.env['GUARDDOG_DATABASE_URL']! })
    await owner.connect()
    await owner.query(TEARDOWN_SQL)
    await owner.query(SCHEMA_SQL)

    const guard = buildSyntheticGuard()
    const ops = compileToOps(guard)
    const sql = renderOps(ops, { claims: guard.config.claims })
    for (const stmt of sql) {
      await owner.query(stmt)
    }
    await owner.query('GRANT SELECT ON poly_alpha, poly_beta, poly_attachment TO poly_user')
    await owner.query('GRANT USAGE ON SCHEMA public TO poly_user')

    await owner.query(SEED_SQL)
  }, 30_000)

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.query(TEARDOWN_SQL)
      await owner.end()
    }
  })

  it('tenant-only claim: Alpha attachment visible, Beta attachment hidden', async () => {
    await withScenario(
      owner,
      { role: 'poly_user', claims: { sub: ALPHA_ID, tenantId: TENANT, betaGrants: [] } },
      async (db) => {
        const result = await assertAllowed(
          db.query<{ id: string; targetType: string }>(
            'SELECT id, "targetType" FROM poly_attachment ORDER BY "targetType"',
            []
          )
        )
        expect(result.rows.map((r) => r.targetType)).toEqual(['Alpha'])
      }
    )
  })

  it('beta grant present in claim: both attachments visible', async () => {
    await withScenario(
      owner,
      { role: 'poly_user', claims: { sub: ALPHA_ID, tenantId: TENANT, betaGrants: [BETA_ID] } },
      async (db) => {
        const result = await assertAllowed(
          db.query<{ id: string; targetType: string }>(
            'SELECT id, "targetType" FROM poly_attachment ORDER BY "targetType"',
            []
          )
        )
        expect(result.rows.map((r) => r.targetType)).toEqual(['Alpha', 'Beta'])
      }
    )
  })

  it('cross-tenant attempt: neither attachment visible from a different tenant', async () => {
    const otherTenant = '00000000-0000-0000-0000-000000008888'
    await withScenario(
      owner,
      { role: 'poly_user', claims: { sub: ALPHA_ID, tenantId: otherTenant, betaGrants: [BETA_ID] } },
      async (db) => {
        const result = await assertAllowed(db.query<{ id: string }>('SELECT id FROM poly_attachment', []))
        expect(result.rows).toHaveLength(0)
      }
    )
  })
})
