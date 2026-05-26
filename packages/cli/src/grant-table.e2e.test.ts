/**
 * Table-backed resourceGrants E2E.
 *
 * Proves the alpha.2 `source: 'table'` path end-to-end:
 *   1. Author a policy with `p.hasGrant('edit', col('workspaceId'))` on a
 *      child table (`Doc`) whose rows carry a `workspaceId` FK.
 *   2. Render SQL via `compileToOps` + `renderOps` with a Guarddog whose
 *      resourceGrants are `source: 'table'` (per-resource override for
 *      `workspaceId`) AND a polymorphic fallback for `tenantId`.
 *   3. Apply against real Postgres alongside seed: two Doc rows in
 *      different workspaces; one workspace_grant row tying the granted
 *      user to one of them; one resource_grant row tying the same user
 *      to the tenant for the polymorphic path.
 *   4. Verify the user with a grant sees only the doc whose workspace
 *      they have a grant on; the user without sees zero. Same for the
 *      polymorphic fallback path.
 *
 * Lives in the CLI package (not testing-postgres) for the same reason as
 * polymorphic-synthetic.e2e.test.ts: `renderOps` is a CLI-package export.
 *
 * Skipped unless `GUARDDOG_E2E=1` + `GUARDDOG_DATABASE_URL` are set.
 *
 * **Role naming convention for parallel e2e files:** vitest runs test files
 * in the same package in parallel, all hitting the same Postgres database.
 * Each e2e file must namespace its CREATE/DROP ROLE statements to avoid
 * racing with peers — here we use `grant_table_user` instead of the
 * generic `app_user` so we can't collide with polymorphic-synthetic.
 */

import {
  col,
  compileToOps,
  defineAppRoles,
  defineClaims,
  defineDbRoles,
  defineResourceGrants,
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

const TENANT = '00000000-0000-0000-0000-000000003333'
const WORKSPACE_OK = '00000000-0000-0000-0000-00000000aa01'
const WORKSPACE_BLOCKED = '00000000-0000-0000-0000-00000000aa02'
const DOC_IN_OK = '00000000-0000-0000-0000-00000000d001'
const DOC_IN_BLOCKED = '00000000-0000-0000-0000-00000000d002'
const TENANT_RECORD_ID = '00000000-0000-0000-0000-00000000bb01'
const USER_GRANTED = '00000000-0000-0000-0000-00000000ee01'
const USER_OTHER = '00000000-0000-0000-0000-00000000ee02'

const SCHEMA_SQL = `
  CREATE TABLE doc (
    id            uuid PRIMARY KEY,
    "tenantId"    uuid NOT NULL,
    "workspaceId" uuid NOT NULL,
    title         text NOT NULL
  );
  CREATE TABLE tenant_record (
    id          uuid PRIMARY KEY,
    "tenantId"  uuid NOT NULL,
    note        text NOT NULL
  );
  CREATE TABLE workspace_grant (
    "userId"      uuid NOT NULL,
    "workspaceId" uuid NOT NULL,
    actions       text[] NOT NULL,
    PRIMARY KEY ("userId", "workspaceId")
  );
  CREATE TABLE resource_grant (
    "userId"        uuid NOT NULL,
    "resourceType"  text NOT NULL,
    "resourceId"    uuid NOT NULL,
    actions         text[] NOT NULL,
    PRIMARY KEY ("userId", "resourceType", "resourceId")
  );
`

const SEED_SQL = `
  INSERT INTO doc (id, "tenantId", "workspaceId", title) VALUES
    ('${DOC_IN_OK}',      '${TENANT}', '${WORKSPACE_OK}',      'reachable doc'),
    ('${DOC_IN_BLOCKED}', '${TENANT}', '${WORKSPACE_BLOCKED}', 'no-grant doc');
  INSERT INTO tenant_record (id, "tenantId", note) VALUES
    ('${TENANT_RECORD_ID}', '${TENANT}', 'tenant-scoped fallback target');
  INSERT INTO workspace_grant ("userId", "workspaceId", actions) VALUES
    ('${USER_GRANTED}', '${WORKSPACE_OK}', ARRAY['edit']);
  INSERT INTO resource_grant ("userId", "resourceType", "resourceId", actions) VALUES
    ('${USER_GRANTED}', 'Tenant', '${TENANT}', ARRAY['edit']);
`

const TEARDOWN_SQL = `
  DROP TABLE IF EXISTS resource_grant, workspace_grant, tenant_record, doc CASCADE;
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grant_table_user') THEN
      EXECUTE 'DROP OWNED BY grant_table_user CASCADE';
      EXECUTE 'DROP ROLE grant_table_user';
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
    dbRoles: defineDbRoles({ grant_table_user: { inherits: [], nologin: true } }),
    appRoles: defineAppRoles({}),
    resources: defineResources({}),
    resourceGrants: defineResourceGrants({
      source: 'table',
      actions: ['edit'] as const,
      tables: {
        workspaceId: {
          name: 'workspace_grant',
          principalColumn: 'userId',
          actionsColumn: 'actions',
        },
      },
      fallbackTable: {
        name: 'resource_grant',
        principalColumn: 'userId',
        resourceTypeColumn: 'resourceType',
        resourceIdColumn: 'resourceId',
        actionsColumn: 'actions',
        scopeColumnTypeMap: { tenantId: 'Tenant' },
      },
    }),
  })
}

describe.skipIf(!enabled)('table-backed resourceGrants E2E (alpha.2)', () => {
  let owner: Client

  beforeAll(async () => {
    owner = new Client({ connectionString: process.env['GUARDDOG_DATABASE_URL']! })
    await owner.connect()
    await owner.query(TEARDOWN_SQL)
    await owner.query(SCHEMA_SQL)

    const guard = buildGuard()
    guard
      .model('Doc')
      .policy('grant_table_user')
      .select((p) =>
        p
          .claim('tenantId')
          .eq(col('tenantId'))
          .and(p.hasGrant('edit', col('workspaceId')))
      )
    guard
      .model('TenantRecord')
      .policy('grant_table_user')
      .select((p) =>
        p
          .claim('tenantId')
          .eq(col('tenantId'))
          .and(p.hasGrant('edit', col('tenantId')))
      )

    const ops = compileToOps(guard)
    const sql = renderOps(ops, {
      claims: guard.config.claims,
      ...(guard.config.resourceGrants !== undefined && { resourceGrants: guard.config.resourceGrants }),
    })
    for (const stmt of sql) {
      await owner.query(stmt)
    }
    await owner.query('GRANT SELECT ON doc, tenant_record TO grant_table_user')
    // The grant tables themselves must be readable by grant_table_user so the
    // EXISTS sub-query can see them; in a real deployment these would be
    // RLS'd in their own right, but the simplest convincing test grants
    // table-level SELECT and trusts the row-level joins.
    await owner.query('GRANT SELECT ON workspace_grant, resource_grant TO grant_table_user')
    await owner.query('GRANT USAGE ON SCHEMA public TO grant_table_user')

    await owner.query(SEED_SQL)
  }, 30_000)

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.query(TEARDOWN_SQL)
      await owner.end()
    }
  })

  describe('per-resource table (workspace_grant) — outer-row correlation', () => {
    it("user with a grant on WORKSPACE_OK sees only that workspace's doc", async () => {
      await withScenario(
        owner,
        { role: 'grant_table_user', claims: { sub: USER_GRANTED, tenantId: TENANT } },
        async (db) => {
          const result = await assertAllowed(db.query<{ id: string }>('SELECT id FROM doc', []))
          expect(result.rows.map((r) => r.id)).toEqual([DOC_IN_OK])
        }
      )
    })

    it('user without any grant rows sees zero docs', async () => {
      await withScenario(
        owner,
        { role: 'grant_table_user', claims: { sub: USER_OTHER, tenantId: TENANT } },
        async (db) => {
          const result = await assertAllowed(db.query<{ id: string }>('SELECT id FROM doc', []))
          expect(result.rows).toHaveLength(0)
        }
      )
    })
  })

  describe('polymorphic fallback (resource_grant)', () => {
    it('user with a fallback grant sees the tenant-scoped record', async () => {
      await withScenario(
        owner,
        { role: 'grant_table_user', claims: { sub: USER_GRANTED, tenantId: TENANT } },
        async (db) => {
          const result = await assertAllowed(db.query<{ id: string }>('SELECT id FROM tenant_record', []))
          expect(result.rows.map((r) => r.id)).toEqual([TENANT_RECORD_ID])
        }
      )
    })

    it('user without a fallback grant sees nothing', async () => {
      await withScenario(
        owner,
        { role: 'grant_table_user', claims: { sub: USER_OTHER, tenantId: TENANT } },
        async (db) => {
          const result = await assertAllowed(db.query<{ id: string }>('SELECT id FROM tenant_record', []))
          expect(result.rows).toHaveLength(0)
        }
      )
    })
  })
})
