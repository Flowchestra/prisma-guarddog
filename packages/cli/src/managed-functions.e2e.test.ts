/**
 * Managed-functions E2E (#15 / ADR-0026).
 *
 * Proves the `defineFunctions` lifecycle end-to-end against real Postgres:
 *   1. Author a function `fn_e2e.is_owner(owner uuid, uid uuid)` and a Doc
 *      SELECT policy gated by `p.fn('is_owner', col('ownerId'), p.claim('sub'))`.
 *   2. Apply `compileToOps` + `renderOps` — proves CREATE SCHEMA, CREATE
 *      FUNCTION, GRANT USAGE/EXECUTE, and a `p.fn(...)`-compiled policy all
 *      run against Postgres and enforce row ownership.
 *   3. Evolve the function's SIGNATURE (add a trailing `allow_all` arg) and
 *      the policy call, then apply `diffStates(v1, v2)` — proves the
 *      signature-aware diff emits DROP+CREATE FUNCTION, re-GRANTs EXECUTE
 *      (wiped by the drop), and re-creates the dependent policy, and that the
 *      migrated function changes behavior (allow_all => every row visible).
 *
 * Role/schema are namespaced (`fn_mgmt_user`, `fn_e2e`) so this file can run
 * in parallel with the other CLI e2e files against the same database.
 *
 * Skipped unless `GUARDDOG_E2E=1` + a valid `GUARDDOG_DATABASE_URL` are set.
 */

import {
  col,
  compileToOps,
  compileToState,
  defineAppRoles,
  defineClaims,
  defineDbRoles,
  defineFunctions,
  defineResources,
  diffStates,
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

const DOC_MINE = '00000000-0000-0000-0000-0000000fd001'
const DOC_THEIRS = '00000000-0000-0000-0000-0000000fd002'
const USER_ME = '00000000-0000-0000-0000-0000000fe001'
const USER_OTHER = '00000000-0000-0000-0000-0000000fe002'

const SCHEMA_SQL = `
  CREATE TABLE fn_doc (
    id        uuid PRIMARY KEY,
    "ownerId" uuid NOT NULL,
    title     text NOT NULL
  );
`

const SEED_SQL = `
  INSERT INTO fn_doc (id, "ownerId", title) VALUES
    ('${DOC_MINE}',   '${USER_ME}',    'mine'),
    ('${DOC_THEIRS}', '${USER_OTHER}', 'theirs');
`

const TEARDOWN_SQL = `
  DROP TABLE IF EXISTS fn_doc CASCADE;
  DROP SCHEMA IF EXISTS fn_e2e CASCADE;
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fn_mgmt_user') THEN
      EXECUTE 'DROP OWNED BY fn_mgmt_user CASCADE';
      EXECUTE 'DROP ROLE fn_mgmt_user';
    END IF;
  END
  $$;
`

function baseConfig() {
  return {
    claims: defineClaims({ accessor: 'request.jwt.claims', shape: (c) => ({ sub: c.uuid() }) }),
    dbRoles: defineDbRoles({ fn_mgmt_user: { inherits: [], nologin: true } }),
    appRoles: defineAppRoles({}),
    resources: defineResources({}),
  }
}

// v1: two-arg ownership predicate.
function buildGuardV1() {
  const guard = new Guarddog({
    ...baseConfig(),
    functions: defineFunctions({
      schema: 'fn_e2e',
      fns: {
        is_owner: {
          args: [
            { name: 'owner', type: 'uuid' },
            { name: 'uid', type: 'uuid' },
          ],
          returns: 'boolean',
          volatility: 'immutable',
          grants: { execute: ['fn_mgmt_user'] },
          body: 'SELECT owner = uid',
        },
      },
    }),
  })
  guard
    .model('FnDoc')
    .table('fn_doc')
    .policy('fn_mgmt_user')
    .select((p) => p.fn('is_owner', col('ownerId'), p.claim('sub')))
  return guard
}

// v2: signature change — trailing allow_all arg flips behavior to "see all".
function buildGuardV2() {
  const guard = new Guarddog({
    ...baseConfig(),
    functions: defineFunctions({
      schema: 'fn_e2e',
      fns: {
        is_owner: {
          args: [
            { name: 'owner', type: 'uuid' },
            { name: 'uid', type: 'uuid' },
            { name: 'allow_all', type: 'boolean', default: 'false' },
          ],
          returns: 'boolean',
          volatility: 'immutable',
          grants: { execute: ['fn_mgmt_user'] },
          body: 'SELECT allow_all OR owner = uid',
        },
      },
    }),
  })
  guard
    .model('FnDoc')
    .table('fn_doc')
    .policy('fn_mgmt_user')
    .select((p) => p.fn('is_owner', col('ownerId'), p.claim('sub'), p.literal(true)))
  return guard
}

describe.skipIf(!enabled)('managed functions E2E (#15)', () => {
  let owner: Client

  beforeAll(async () => {
    owner = new Client({ connectionString: process.env['GUARDDOG_DATABASE_URL']! })
    await owner.connect()
    await owner.query(TEARDOWN_SQL)
    await owner.query(SCHEMA_SQL)

    const guard = buildGuardV1()
    const sql = renderOps(compileToOps(guard), {
      claims: guard.config.claims,
      functionSchema: guard.config.functions!.schema,
    })
    for (const stmt of sql) await owner.query(stmt)
    await owner.query('GRANT SELECT ON fn_doc TO fn_mgmt_user')
    await owner.query('GRANT USAGE ON SCHEMA public TO fn_mgmt_user')
    await owner.query(SEED_SQL)
  }, 30_000)

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.query(TEARDOWN_SQL)
      await owner.end()
    }
  })

  it('v1: a function-gated policy restricts rows to the owner', async () => {
    await withScenario(owner, { role: 'fn_mgmt_user', claims: { sub: USER_ME } }, async (db) => {
      const result = await assertAllowed(db.query<{ id: string }>('SELECT id FROM fn_doc', []))
      expect(result.rows.map((r) => r.id)).toEqual([DOC_MINE])
    })
  })

  it('v1: a different user sees only their own row', async () => {
    await withScenario(owner, { role: 'fn_mgmt_user', claims: { sub: USER_OTHER } }, async (db) => {
      const result = await assertAllowed(db.query<{ id: string }>('SELECT id FROM fn_doc', []))
      expect(result.rows.map((r) => r.id)).toEqual([DOC_THEIRS])
    })
  })

  it('migrates a function signature change (drop+create+regrant) and flips behavior', async () => {
    const current = compileToState(buildGuardV1())
    const target = compileToState(buildGuardV2())
    const ops = diffStates(current, target)
    // sanity: the diff really is a drop+recreate, not a CREATE OR REPLACE
    expect(ops.some((o) => o.kind === 'drop-function')).toBe(true)
    expect(ops.some((o) => o.kind === 'grant-execute')).toBe(true)

    const guard = buildGuardV2()
    const sql = renderOps(ops, {
      claims: guard.config.claims,
      functionSchema: guard.config.functions!.schema,
    })
    for (const stmt of sql) await owner.query(stmt)

    // allow_all=true now: USER_ME sees every row.
    await withScenario(owner, { role: 'fn_mgmt_user', claims: { sub: USER_ME } }, async (db) => {
      const result = await assertAllowed(db.query<{ id: string }>('SELECT id FROM fn_doc ORDER BY title', []))
      expect(result.rows.map((r) => r.id)).toEqual([DOC_MINE, DOC_THEIRS])
    })
  })
})
