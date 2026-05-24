/**
 * Table-backed resourceGrants E2E.
 *
 * Proves the alpha.2 `source: 'table'` path end-to-end:
 *   1. Author a policy with `p.hasGrant('edit', col('workspaceId'))`.
 *   2. Render SQL via `compileToOps` + `renderOps` with a Guarddog whose
 *      resourceGrants are `source: 'table'` (per-resource override) AND
 *      a polymorphic fallback for tenantId.
 *   3. Apply against real Postgres alongside a grant table seeded with
 *      one row that should match and one row that should not.
 *   4. Verify the user with a grant sees the row; the user without does
 *      not; the polymorphic fallback path also enforces.
 *
 * Lives in the CLI package (not testing-postgres) for the same reason as
 * polymorphic-synthetic.e2e.test.ts: `renderOps` is a CLI-package export.
 *
 * Skipped unless `GUARDDOG_E2E=1` + `GUARDDOG_DATABASE_URL` are set.
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
const USER_GRANTED = '00000000-0000-0000-0000-00000000ee01'
const USER_OTHER = '00000000-0000-0000-0000-00000000ee02'
const SUBJECT_TENANT_RECORD = '00000000-0000-0000-0000-00000000bb01'

const SCHEMA_SQL = `
  CREATE TABLE grant_workspace (
    id          uuid PRIMARY KEY,
    "tenantId"  uuid NOT NULL,
    label       text NOT NULL
  );
  CREATE TABLE grant_tenant_record (
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
  INSERT INTO grant_workspace (id, "tenantId", label) VALUES
    ('${WORKSPACE_OK}',      '${TENANT}', 'reachable'),
    ('${WORKSPACE_BLOCKED}', '${TENANT}', 'no-grant');
  INSERT INTO grant_tenant_record (id, "tenantId", note) VALUES
    ('${SUBJECT_TENANT_RECORD}', '${TENANT}', 'tenant-scoped fallback target');
  INSERT INTO workspace_grant ("userId", "workspaceId", actions) VALUES
    ('${USER_GRANTED}', '${WORKSPACE_OK}', ARRAY['edit']);
  INSERT INTO resource_grant ("userId", "resourceType", "resourceId", actions) VALUES
    ('${USER_GRANTED}', 'Tenant', '${TENANT}', ARRAY['edit']);
`

const TEARDOWN_SQL = `
  DROP TABLE IF EXISTS resource_grant, workspace_grant, grant_tenant_record, grant_workspace CASCADE;
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
      EXECUTE 'DROP OWNED BY app_user CASCADE';
      EXECUTE 'DROP ROLE app_user';
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
    dbRoles: defineDbRoles({ app_user: { inherits: [], nologin: true } }),
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
      .model('GrantWorkspace')
      .policy('app_user')
      .select((p) =>
        p
          .claim('tenantId')
          .eq(col('tenantId'))
          .and(p.hasGrant('edit', col('workspaceId')))
      )
    guard
      .model('GrantTenantRecord')
      .policy('app_user')
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
    await owner.query('GRANT SELECT ON grant_workspace, grant_tenant_record TO app_user')
    // The grant tables themselves must be readable by app_user so the EXISTS
    // sub-query can see them; in a real deployment these would be RLS'd in
    // their own right, but the simplest convincing test grants table-level
    // SELECT and trusts the row-level joins.
    await owner.query('GRANT SELECT ON workspace_grant, resource_grant TO app_user')
    await owner.query('GRANT USAGE ON SCHEMA public TO app_user')

    await owner.query(SEED_SQL)
  }, 30_000)

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.query(TEARDOWN_SQL)
      await owner.end()
    }
  })

  describe('per-resource table (workspace_grant)', () => {
    it('user with a grant row sees the workspace', async () => {
      await withScenario(owner, { role: 'app_user', claims: { sub: USER_GRANTED, tenantId: TENANT } }, async (db) => {
        const result = await assertAllowed(db.query<{ id: string }>('SELECT id FROM grant_workspace', []))
        expect(result.rows.map((r) => r.id)).toEqual([WORKSPACE_OK])
      })
    })

    it('user without a grant row sees nothing', async () => {
      await withScenario(owner, { role: 'app_user', claims: { sub: USER_OTHER, tenantId: TENANT } }, async (db) => {
        const result = await assertAllowed(db.query<{ id: string }>('SELECT id FROM grant_workspace', []))
        expect(result.rows).toHaveLength(0)
      })
    })
  })

  describe('polymorphic fallback (resource_grant)', () => {
    it('user with a fallback grant sees the tenant-scoped record', async () => {
      await withScenario(owner, { role: 'app_user', claims: { sub: USER_GRANTED, tenantId: TENANT } }, async (db) => {
        const result = await assertAllowed(db.query<{ id: string }>('SELECT id FROM grant_tenant_record', []))
        expect(result.rows.map((r) => r.id)).toEqual([SUBJECT_TENANT_RECORD])
      })
    })

    it('user without a fallback grant sees nothing', async () => {
      await withScenario(owner, { role: 'app_user', claims: { sub: USER_OTHER, tenantId: TENANT } }, async (db) => {
        const result = await assertAllowed(db.query<{ id: string }>('SELECT id FROM grant_tenant_record', []))
        expect(result.rows).toHaveLength(0)
      })
    })
  })
})
