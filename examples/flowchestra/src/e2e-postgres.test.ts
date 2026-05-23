/**
 * End-to-end RLS verification against a real Postgres instance.
 *
 * Skipped unless `GUARDDOG_E2E=1` and `GUARDDOG_DATABASE_URL` are both set.
 * Hard requirement of ADR-0013: the harness only signals truth against
 * real Postgres — pg-mem/pglite shims don't implement enough of
 * `SET ROLE`, `current_setting()`, and column GRANTs to validate
 * policies honestly.
 *
 * Test flow:
 *   1. Connect to the configured database.
 *   2. CREATE TABLEs for the five example models (kept in this file so
 *      the test is self-contained — no external migration).
 *   3. Apply the rendered guarddog SQL (compileToOps -> renderOps).
 *   4. Seed two tenants' worth of fixture data as the table owner.
 *   5. Run scenarios via `withScenario` + assertion helpers.
 *   6. DROP TABLEs + ROLEs to leave the database as we found it.
 *
 * Local run:
 *   GUARDDOG_E2E=1 GUARDDOG_DATABASE_URL=postgres://... pnpm --filter example-flowchestra test:e2e
 */

import { compileToOps } from '@prisma-guarddog/core'
import { assertAllowed, assertDenied, withScenario } from '@prisma-guarddog/testing-postgres'
// eslint-disable-next-line import/no-extraneous-dependencies -- pg is a devDependency of this example package.
import { Client } from 'pg'
import { renderOps } from 'prisma-guarddog'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildExampleGuarddog } from './guarddog.js'

const enabled = process.env['GUARDDOG_E2E'] === '1' && typeof process.env['GUARDDOG_DATABASE_URL'] === 'string'

const TENANT_A = '00000000-0000-0000-0000-00000000000a'
const TENANT_B = '00000000-0000-0000-0000-00000000000b'
const WORKSPACE_A = '00000000-0000-0000-0000-00000000ffaa'
const WORKSPACE_B = '00000000-0000-0000-0000-00000000ffbb'
const WORKBENCH_A = '00000000-0000-0000-0000-0000aaaaaaaa'

const SCHEMA_SQL = `
  CREATE TABLE workspace (
    id          uuid PRIMARY KEY,
    "tenantId"  uuid NOT NULL,
    name        text NOT NULL
  );
  CREATE TABLE workbench (
    id            uuid PRIMARY KEY,
    "tenantId"    uuid NOT NULL,
    "workspaceId" uuid NOT NULL REFERENCES workspace(id),
    name          text NOT NULL
  );
  CREATE TABLE file (
    id                 uuid PRIMARY KEY,
    "tenantId"         uuid NOT NULL,
    "workbenchId"      uuid NOT NULL REFERENCES workbench(id),
    "ownerId"          uuid NOT NULL,
    name               text NOT NULL,
    "storageKey"       text NOT NULL,
    "embeddingPayload" jsonb
  );
  CREATE TABLE tool_invocation (
    id          uuid PRIMARY KEY,
    "tenantId"  uuid NOT NULL,
    tool        text NOT NULL
  );
  CREATE TABLE "MigrationLedger" (
    id      bigserial PRIMARY KEY,
    name    text NOT NULL
  );
`

const SEED_SQL = `
  INSERT INTO workspace (id, "tenantId", name) VALUES
    ($1, $2, 'workspace-a'),
    ($3, $4, 'workspace-b');
  INSERT INTO workbench (id, "tenantId", "workspaceId", name) VALUES
    ($5, $2, $1, 'workbench-a');
  INSERT INTO file (id, "tenantId", "workbenchId", "ownerId", name, "storageKey") VALUES
    ($6, $2, $5, $7, 'file-a', 's3://a');
`

const TEARDOWN_SQL = `
  DROP TABLE IF EXISTS file, tool_invocation, workbench, workspace, "MigrationLedger" CASCADE;
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
      EXECUTE 'DROP OWNED BY app_user CASCADE';
      EXECUTE 'DROP ROLE app_user';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_system') THEN
      EXECUTE 'DROP OWNED BY app_system CASCADE';
      EXECUTE 'DROP ROLE app_system';
    END IF;
  END
  $$;
`

describe.skipIf(!enabled)('flowchestra E2E (real postgres)', () => {
  let owner: Client

  beforeAll(async () => {
    owner = new Client({ connectionString: process.env['GUARDDOG_DATABASE_URL']! })
    await owner.connect()
    await owner.query(TEARDOWN_SQL)
    await owner.query(SCHEMA_SQL)

    const guard = buildExampleGuarddog()
    const ops = compileToOps(guard)
    const sql = renderOps(ops, { claims: guard.config.claims })
    // Apply role + RLS + policy DDL in one batch.
    for (const stmt of sql) {
      await owner.query(stmt)
    }
    // GRANT base table privileges so app_user can SELECT/INSERT at all
    // (RLS narrows; GRANT gates the table itself).
    await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON workspace, workbench, file, tool_invocation TO app_user')
    await owner.query(`GRANT USAGE ON SCHEMA public TO app_user`)

    await owner.query(SEED_SQL, [
      WORKSPACE_A,
      TENANT_A,
      WORKSPACE_B,
      TENANT_B,
      WORKBENCH_A,
      '00000000-0000-0000-0000-00000000fff1',
      '00000000-0000-0000-0000-00000000fff2', // ownerId
    ])
  }, 30_000)

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.query(TEARDOWN_SQL)
      await owner.end()
    }
  })

  it('app_user in tenant A sees only tenant A workspaces', async () => {
    await withScenario(owner, { role: 'app_user', claims: { sub: 'u1', tenantId: TENANT_A } }, async (db) => {
      const result = await assertAllowed(db.query<{ id: string }>('SELECT id FROM workspace', []))
      expect(result.rows.map((r) => r.id)).toEqual([WORKSPACE_A])
    })
  })

  it('app_user is denied inserts into another tenant', async () => {
    await withScenario(owner, { role: 'app_user', claims: { sub: 'u1', tenantId: TENANT_A } }, async (db) => {
      await assertDenied(
        db.query(`INSERT INTO workspace (id, "tenantId", name) VALUES ($1, $2, 'sneaky')`, [
          '00000000-0000-0000-0000-00000000bad1',
          TENANT_B,
        ])
      )
    })
  })

  it('app_user cannot see the sensitive File storageKey column', async () => {
    await withScenario(owner, { role: 'app_user', claims: { sub: 'u1', tenantId: TENANT_A } }, async (db) => {
      await assertDenied(db.query('SELECT "storageKey" FROM file', []))
    })
  })
})
