/**
 * Rank-based + principal-disjunction grant E2E (issues #5 + #6).
 *
 * Exercises the two alpha.3 grant-table features composed on a single
 * table, end-to-end against real Postgres:
 *   - roleColumn + roleHierarchy: "user has at least rank EDITOR"
 *   - principalUserColumn + principalGroupColumn + groupMemberTable:
 *     the grant matches by direct user OR by group membership
 *
 * Fixture: a `project` child table (FK workspaceId) with a SELECT policy
 * `hasGrant('EDITOR', col('workspaceId'))`. The grant table carries
 * (userId XOR groupId, workspaceId, role). Seeds:
 *   - group GROUP_A; USER_GROUP is a member of it
 *   - grant: GROUP_A has EDITOR on WS_OK            (group path, sufficient rank)
 *   - grant: USER_LOW (direct) has READER on WS_OK  (direct path, rank too low)
 *   - one project in WS_OK
 *
 * Expectations:
 *   - USER_GROUP sees the project (group grant, EDITOR ≥ EDITOR)
 *   - USER_LOW does not (READER < EDITOR)
 *   - USER_NONE does not (no grant at all)
 *
 * Skipped unless `GUARDDOG_E2E=1` + `GUARDDOG_DATABASE_URL` are set.
 * Role is namespaced (`rank_group_user`) to avoid colliding with the other
 * e2e files that run in parallel against the same database.
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

const WS_OK = '00000000-0000-0000-0000-0000000a0001'
const PROJECT_OK = '00000000-0000-0000-0000-0000000b0001'
const GROUP_A = '00000000-0000-0000-0000-0000000c0001'
const USER_GROUP = '00000000-0000-0000-0000-0000000d0001'
const USER_LOW = '00000000-0000-0000-0000-0000000e0001'
const USER_NONE = '00000000-0000-0000-0000-0000000f0001'

const SCHEMA_SQL = `
  CREATE TABLE project (
    id            uuid PRIMARY KEY,
    "workspaceId" uuid NOT NULL,
    title         text NOT NULL
  );
  CREATE TABLE rg_grant (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId"      uuid NULL,
    "groupId"     uuid NULL,
    "workspaceId" uuid NOT NULL,
    role          text NOT NULL,
    CONSTRAINT rg_grant_principal_xor CHECK (("userId" IS NULL) <> ("groupId" IS NULL))
  );
  CREATE TABLE rg_group_member (
    "userId"   uuid NOT NULL,
    "groupId"  uuid NOT NULL,
    PRIMARY KEY ("userId", "groupId")
  );
`

const SEED_SQL = `
  INSERT INTO project (id, "workspaceId", title) VALUES ('${PROJECT_OK}', '${WS_OK}', 'project-ok');
  INSERT INTO rg_group_member ("userId", "groupId") VALUES ('${USER_GROUP}', '${GROUP_A}');
  INSERT INTO rg_grant ("groupId", "workspaceId", role) VALUES ('${GROUP_A}', '${WS_OK}', 'EDITOR');
  INSERT INTO rg_grant ("userId", "workspaceId", role)  VALUES ('${USER_LOW}', '${WS_OK}', 'READER');
`

const TEARDOWN_SQL = `
  DROP TABLE IF EXISTS rg_group_member, rg_grant, project CASCADE;
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rank_group_user') THEN
      EXECUTE 'DROP OWNED BY rank_group_user CASCADE';
      EXECUTE 'DROP ROLE rank_group_user';
    END IF;
  END
  $$;
`

function buildGuard() {
  return new Guarddog({
    claims: defineClaims({
      accessor: 'request.jwt.claims',
      shape: (c) => ({ sub: c.uuid() }),
    }),
    dbRoles: defineDbRoles({ rank_group_user: { inherits: [], nologin: true } }),
    appRoles: defineAppRoles({}),
    resources: defineResources({}),
    resourceGrants: defineResourceGrants({
      source: 'table',
      actions: ['READER', 'EDITOR', 'MANAGER', 'OWNER'] as const,
      tables: {
        workspaceId: {
          name: 'rg_grant',
          principalUserColumn: 'userId',
          principalGroupColumn: 'groupId',
          groupMemberTable: { name: 'rg_group_member', userColumn: 'userId', groupColumn: 'groupId' },
          roleColumn: 'role',
          roleHierarchy: ['READER', 'EDITOR', 'MANAGER', 'OWNER'],
        },
      },
    }),
  })
}

describe.skipIf(!enabled)('rank + principal-disjunction grant E2E (issues #5/#6)', () => {
  let owner: Client

  beforeAll(async () => {
    owner = new Client({ connectionString: process.env['GUARDDOG_DATABASE_URL']! })
    await owner.connect()
    await owner.query(TEARDOWN_SQL)
    await owner.query(SCHEMA_SQL)

    const guard = buildGuard()
    guard
      .model('Project')
      .policy('rank_group_user')
      .select((p) => p.hasGrant('EDITOR', col('workspaceId')))

    const ops = compileToOps(guard)
    const sql = renderOps(ops, {
      claims: guard.config.claims,
      ...(guard.config.resourceGrants !== undefined && { resourceGrants: guard.config.resourceGrants }),
    })
    for (const stmt of sql) {
      await owner.query(stmt)
    }
    await owner.query('GRANT SELECT ON project TO rank_group_user')
    await owner.query('GRANT SELECT ON rg_grant, rg_group_member TO rank_group_user')
    await owner.query('GRANT USAGE ON SCHEMA public TO rank_group_user')

    await owner.query(SEED_SQL)
  }, 30_000)

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.query(TEARDOWN_SQL)
      await owner.end()
    }
  })

  it('user with EDITOR via group membership sees the project', async () => {
    await withScenario(owner, { role: 'rank_group_user', claims: { sub: USER_GROUP } }, async (db) => {
      const result = await assertAllowed(db.query<{ id: string }>('SELECT id FROM project', []))
      expect(result.rows.map((r) => r.id)).toEqual([PROJECT_OK])
    })
  })

  it('user with only READER (below EDITOR) sees nothing — rank gate holds', async () => {
    await withScenario(owner, { role: 'rank_group_user', claims: { sub: USER_LOW } }, async (db) => {
      const result = await assertAllowed(db.query<{ id: string }>('SELECT id FROM project', []))
      expect(result.rows).toHaveLength(0)
    })
  })

  it('user with no grant (and no group) sees nothing', async () => {
    await withScenario(owner, { role: 'rank_group_user', claims: { sub: USER_NONE } }, async (db) => {
      const result = await assertAllowed(db.query<{ id: string }>('SELECT id FROM project', []))
      expect(result.rows).toHaveLength(0)
    })
  })
})
