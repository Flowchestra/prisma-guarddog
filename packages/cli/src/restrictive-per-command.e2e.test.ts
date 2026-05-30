/**
 * Per-command restrictive E2E (ADR-0034).
 *
 * Proves per-command restrictives are **catalog-distinct** — each declared
 * verb emits as its own `pg_policies` row with `cmd = SELECT / INSERT /
 * UPDATE / DELETE` — and that the SELECT-only restrictive filters reads
 * without blocking INSERTs of the same shape.
 *
 * Two interlocking demonstrations:
 *
 *   A. `forSelect(deletedAt IS NULL)` — emits `AS RESTRICTIVE FOR SELECT`
 *      and filters soft-deleted rows out of reads.
 *
 *   B. `forInsert({ check: deletedAt IS NULL })` — emits `AS RESTRICTIVE FOR
 *      INSERT` and blocks creating new pre-soft-deleted rows. The role's
 *      writes are otherwise permitted by a permissive insert policy; this
 *      test proves the per-command restrictive AND's only on INSERT, not on
 *      SELECT.
 *
 * Note on Postgres semantics: SELECT policies (permissive and restrictive)
 * also gate row-visibility for UPDATE/DELETE row-finding by `WHERE id = ...`.
 * That's a Postgres behavior, not a guarddog one — it means a SELECT-only
 * restrictive isn't the same as "block reads but allow writes on the
 * filtered row." For undelete flows in practice, use a BYPASSRLS role
 * (`app_system`) or split the work behind a SECURITY DEFINER function.
 *
 * Role-naming convention (per polymorphic-synthetic.e2e.test.ts): uses
 * `per_cmd_user` to avoid collisions with parallel e2e files.
 */

import {
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

const GIZMO_ACTIVE = '00000000-0000-0000-0000-000000009aa1'
const GIZMO_DELETED = '00000000-0000-0000-0000-000000009aa2'

const SCHEMA_SQL = `
  CREATE TABLE gizmo (
    id          uuid PRIMARY KEY,
    "deletedAt" timestamptz NULL,
    payload     text NOT NULL
  );
`

const SEED_SQL = `
  INSERT INTO gizmo (id, "deletedAt", payload) VALUES
    ('${GIZMO_ACTIVE}',  NULL,  'active row'),
    ('${GIZMO_DELETED}', NOW(), 'soft-deleted row');
`

const TEARDOWN_SQL = `
  DROP TABLE IF EXISTS gizmo CASCADE;
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'per_cmd_user') THEN
      EXECUTE 'DROP OWNED BY per_cmd_user CASCADE';
      EXECUTE 'DROP ROLE per_cmd_user';
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
    dbRoles: defineDbRoles({ per_cmd_user: { inherits: [], nologin: true } }),
    appRoles: defineAppRoles({}),
    resources: defineResources({}),
  })
}

describe.skipIf(!enabled)('per-command restrictive policies E2E (ADR-0034)', () => {
  let owner: Client

  beforeAll(async () => {
    owner = new Client({ connectionString: process.env['GUARDDOG_DATABASE_URL']! })
    await owner.connect()
    await owner.query(TEARDOWN_SQL)
    await owner.query(SCHEMA_SQL)

    const guard = buildGuard()
    guard
      .model('Gizmo')
      // Two distinct per-command restrictives — one filters SELECT, one
      // blocks INSERT. Each emits as its own pg_policies row with the
      // matching `cmd` value.
      .restrictivePolicy('public', 'no_soft_deleted')
      .forSelect((p) => p.raw('"deletedAt" IS NULL'))
    guard
      .model('Gizmo')
      .restrictivePolicy('public', 'no_pre_deleted')
      .forInsert({ check: (p) => p.raw('"deletedAt" IS NULL') })
    // Permissive access for the test role — would otherwise expose everything.
    guard
      .model('Gizmo')
      .policy('per_cmd_user')
      .select((p) => p.literal(true))
      .insert({ check: (p) => p.literal(true) })

    const ops = compileToOps(guard)
    const sql = renderOps(ops, { claims: guard.config.claims })
    for (const stmt of sql) {
      await owner.query(stmt)
    }
    await owner.query('GRANT SELECT, INSERT ON gizmo TO per_cmd_user')

    await owner.query(SEED_SQL)
  }, 30_000)

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.query(TEARDOWN_SQL)
      await owner.end()
    }
  })

  it('per-command restrictives emit as distinct pg_policies rows with the right `cmd`', async () => {
    const result = await owner.query<{ policyname: string; cmd: string; permissive: boolean | string }>(
      `SELECT policyname, cmd, permissive FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'gizmo'
         AND policyname IN ('gizmo_public_no_soft_deleted_select', 'gizmo_public_no_pre_deleted_insert')
       ORDER BY policyname`,
      []
    )
    expect(result.rows).toHaveLength(2)
    const byName = Object.fromEntries(result.rows.map((r) => [r.policyname, r]))
    expect(byName['gizmo_public_no_soft_deleted_select']!.cmd).toBe('SELECT')
    expect(byName['gizmo_public_no_pre_deleted_insert']!.cmd).toBe('INSERT')
    for (const row of result.rows) {
      expect(row.permissive === 'RESTRICTIVE' || row.permissive === false).toBe(true)
    }
  })

  it('SELECT returns only the active row (forSelect restrictive filters the deleted one)', async () => {
    await withScenario(
      owner,
      { role: 'per_cmd_user', claims: { sub: '00000000-0000-0000-0000-000000000001' } },
      async (db) => {
        const result = await assertAllowed(db.query<{ id: string }>('SELECT id FROM gizmo ORDER BY id', []))
        expect(result.rows.map((r) => r.id)).toEqual([GIZMO_ACTIVE])
      }
    )
  })

  it('INSERTing an active row succeeds (passes the forInsert WITH CHECK)', async () => {
    const NEW_ACTIVE = '00000000-0000-0000-0000-00000000beef'
    await withScenario(
      owner,
      { role: 'per_cmd_user', claims: { sub: '00000000-0000-0000-0000-000000000002' } },
      async (db) => {
        await assertAllowed(
          db.query(`INSERT INTO gizmo (id, "deletedAt", payload) VALUES ($1, NULL, 'inserted active')`, [NEW_ACTIVE])
        )
      }
    )
    // Cleanup outside the rolled-back scenario — INSERT happens in a
    // transaction that gets ROLLBACK'd by withScenario, so no cleanup needed.
  })

  it('INSERTing a pre-soft-deleted row fails (forInsert restrictive blocks it)', async () => {
    const NEW_DELETED = '00000000-0000-0000-0000-00000000dead'
    await withScenario(
      owner,
      { role: 'per_cmd_user', claims: { sub: '00000000-0000-0000-0000-000000000003' } },
      async (db) => {
        await expect(
          db.query(`INSERT INTO gizmo (id, "deletedAt", payload) VALUES ($1, NOW(), 'inserted pre-deleted')`, [
            NEW_DELETED,
          ])
        ).rejects.toThrow(/row violates row-level security/i)
      }
    )
  })
})
