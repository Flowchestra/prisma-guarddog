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
 *   2. CREATE TABLEs for the seven example models (kept in this file so
 *      the test is self-contained — no external migration). Tables cover
 *      every Phase 1 scenario in docs/PLAN.md: tenant-only, workspace +
 *      role-gated, workbench cascade, nullable-workbench file, owner
 *      pattern, polymorphic discriminator, opted-out noPolicy.
 *   3. Apply the rendered guarddog SQL (compileToOps -> renderOps).
 *   4. Seed two tenants' worth of fixture data as the table owner.
 *   5. Run scenarios via `withScenario` + assertion helpers.
 *   6. Re-apply the SAME guarddog SQL and assert idempotence (DoD #2:
 *      "5 proof tables emit idempotent SQL that re-applies as no-op").
 *   7. DROP TABLEs + ROLEs to leave the database as we found it.
 *
 * Local run:
 *   GUARDDOG_E2E=1 GUARDDOG_DATABASE_URL=postgres://... pnpm --filter example-flowchestra test:e2e
 */

import { renderOps } from '@flowchestra/prisma-guarddog'
import { compileToOps, materializeSchema } from '@flowchestra/prisma-guarddog-core'
import { assertAllowed, assertDenied, withScenario } from '@flowchestra/prisma-guarddog-testing-postgres'
// eslint-disable-next-line import/no-extraneous-dependencies -- pg is a devDependency of this example package.
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import schema from '../prisma/guarddog.js'

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

const TENANT_A = '00000000-0000-0000-0000-00000000000a'
const TENANT_B = '00000000-0000-0000-0000-00000000000b'
const WORKSPACE_A = '00000000-0000-0000-0000-00000000ffaa'
const WORKSPACE_B = '00000000-0000-0000-0000-00000000ffbb'
const WORKBENCH_A = '00000000-0000-0000-0000-0000aaaaaaaa'
const FILE_WITH_WORKBENCH = '00000000-0000-0000-0000-00000000fff1'
const FILE_LOOSE = '00000000-0000-0000-0000-00000000fff3' // workbenchId NULL
const OWNER_A = '00000000-0000-0000-0000-00000000fff2'
const COMMENT_ON_WORKSPACE = '00000000-0000-0000-0000-0000000cccc1'
const COMMENT_ON_WORKBENCH = '00000000-0000-0000-0000-0000000cccc2'
const COMMENT_ON_FILE = '00000000-0000-0000-0000-0000000cccc3'

const SCHEMA_SQL = `
  CREATE TABLE tenant (
    id    uuid PRIMARY KEY,
    name  text NOT NULL
  );
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
    "workbenchId"      uuid NULL REFERENCES workbench(id),
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
  CREATE TABLE comment (
    id            uuid PRIMARY KEY,
    "tenantId"    uuid NOT NULL,
    "subjectType" text NOT NULL,
    "subjectId"   uuid NOT NULL,
    body          text NOT NULL
  );
  CREATE TABLE "MigrationLedger" (
    id      bigserial PRIMARY KEY,
    name    text NOT NULL
  );
`

// Constants are inlined here instead of via $N parameters so the whole
// block can be sent as a single multi-statement query. pg's extended
// (parameterized) protocol rejects multi-statement strings — the trade is
// either many separate `.query(...)` calls or this one string with
// interpolated UUIDs. UUIDs come from the typed constants above; no user
// input flows in, so the test is not SQL-injection-shaped.
const SEED_SQL = `
  INSERT INTO tenant (id, name) VALUES
    ('${TENANT_A}', 'tenant-a'),
    ('${TENANT_B}', 'tenant-b');
  INSERT INTO workspace (id, "tenantId", name) VALUES
    ('${WORKSPACE_A}', '${TENANT_A}', 'workspace-a'),
    ('${WORKSPACE_B}', '${TENANT_B}', 'workspace-b');
  INSERT INTO workbench (id, "tenantId", "workspaceId", name) VALUES
    ('${WORKBENCH_A}', '${TENANT_A}', '${WORKSPACE_A}', 'workbench-a');
  INSERT INTO file (id, "tenantId", "workbenchId", "ownerId", name, "storageKey") VALUES
    ('${FILE_WITH_WORKBENCH}', '${TENANT_A}', '${WORKBENCH_A}', '${OWNER_A}', 'file-a',     's3://a'),
    ('${FILE_LOOSE}',          '${TENANT_A}', NULL,             '${OWNER_A}', 'file-loose', 's3://loose');
  INSERT INTO comment (id, "tenantId", "subjectType", "subjectId", body) VALUES
    ('${COMMENT_ON_WORKSPACE}', '${TENANT_A}', 'Workspace', '${WORKSPACE_A}',         'comment-on-workspace'),
    ('${COMMENT_ON_WORKBENCH}', '${TENANT_A}', 'Workbench', '${WORKBENCH_A}',         'comment-on-workbench'),
    ('${COMMENT_ON_FILE}',      '${TENANT_A}', 'File',      '${FILE_WITH_WORKBENCH}', 'comment-on-file');
`

const TEARDOWN_SQL = `
  DROP TABLE IF EXISTS comment, file, tool_invocation, workbench, workspace, tenant, "MigrationLedger" CASCADE;
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
  let renderedSql: readonly string[]

  beforeAll(async () => {
    owner = new Client({ connectionString: process.env['GUARDDOG_DATABASE_URL']! })
    await owner.connect()
    await owner.query(TEARDOWN_SQL)
    await owner.query(SCHEMA_SQL)

    const guard = materializeSchema(schema)
    const ops = compileToOps(guard)
    renderedSql = renderOps(ops, { claims: guard.config.claims })
    for (const stmt of renderedSql) {
      await owner.query(stmt)
    }
    // GRANT base table privileges so app_user can SELECT/INSERT at all
    // (RLS narrows; GRANT gates the table itself). `file` is excluded
    // from the bulk GRANT because it carries column-privilege
    // restrictions on `storageKey` and `embeddingPayload` — a table-wide
    // GRANT would override the column-level GRANTs the emitter
    // produced. For `file` we grant column-scoped on the non-restricted
    // columns only; DELETE has no column form so it goes table-wide.
    //
    // (This stitch step is the responsibility of the consumer today —
    //  the column-privilege emitter only emits GRANTs for the declared
    //  role, not REVOKEs from everyone else. See the design note in
    //  packages/emitter-postgres-column-privileges/src/emit.ts.)
    await owner.query(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON tenant, workspace, workbench, tool_invocation, comment TO app_user'
    )
    await owner.query('GRANT SELECT (id, "tenantId", "workbenchId", "ownerId", name) ON file TO app_user')
    await owner.query('GRANT INSERT (id, "tenantId", "workbenchId", "ownerId", name) ON file TO app_user')
    await owner.query('GRANT UPDATE (id, "tenantId", "workbenchId", "ownerId", name) ON file TO app_user')
    await owner.query('GRANT DELETE ON file TO app_user')
    await owner.query(`GRANT USAGE ON SCHEMA public TO app_user`)

    await owner.query(SEED_SQL)
  }, 30_000)

  afterAll(async () => {
    if (owner !== undefined) {
      await owner.query(TEARDOWN_SQL)
      await owner.end()
    }
  })

  describe('scenario (a) — tenant-only', () => {
    it('user in tenant A sees their own tenant row only', async () => {
      await withScenario(owner, { role: 'app_user', claims: { sub: OWNER_A, tenantId: TENANT_A } }, async (db) => {
        const result = await assertAllowed(db.query<{ id: string }>('SELECT id FROM tenant', []))
        expect(result.rows.map((r) => r.id)).toEqual([TENANT_A])
      })
    })
  })

  describe('scenario (b) — workspace-scoped + role-gated', () => {
    it('app_user in tenant A sees only tenant A workspaces', async () => {
      await withScenario(owner, { role: 'app_user', claims: { sub: OWNER_A, tenantId: TENANT_A } }, async (db) => {
        const result = await assertAllowed(db.query<{ id: string }>('SELECT id FROM workspace', []))
        expect(result.rows.map((r) => r.id)).toEqual([WORKSPACE_A])
      })
    })

    it('app_user is denied inserts into another tenant', async () => {
      await withScenario(owner, { role: 'app_user', claims: { sub: OWNER_A, tenantId: TENANT_A } }, async (db) => {
        await assertDenied(
          db.query(`INSERT INTO workspace (id, "tenantId", name) VALUES ($1, $2, 'sneaky')`, [
            '00000000-0000-0000-0000-00000000bad1',
            TENANT_B,
          ])
        )
      })
    })
  })

  describe('scenario (c) — file with NULLABLE workbenchId', () => {
    it('owner sees their loose file (workbenchId IS NULL)', async () => {
      await withScenario(owner, { role: 'app_user', claims: { sub: OWNER_A, tenantId: TENANT_A } }, async (db) => {
        const result = await assertAllowed(db.query<{ id: string }>('SELECT id FROM file WHERE id = $1', [FILE_LOOSE]))
        expect(result.rows).toHaveLength(1)
      })
    })

    it('non-owner in same tenant cannot see the loose file (no workbench grant either)', async () => {
      const otherUser = '00000000-0000-0000-0000-00000000eeee'
      await withScenario(owner, { role: 'app_user', claims: { sub: otherUser, tenantId: TENANT_A } }, async (db) => {
        const result = await assertAllowed(db.query<{ id: string }>('SELECT id FROM file WHERE id = $1', [FILE_LOOSE]))
        expect(result.rows).toHaveLength(0)
      })
    })
  })

  describe('scenario (d) — column-level privilege REVOKE', () => {
    it('app_user cannot see the sensitive File storageKey column', async () => {
      await withScenario(owner, { role: 'app_user', claims: { sub: OWNER_A, tenantId: TENANT_A } }, async (db) => {
        await assertDenied(db.query('SELECT "storageKey" FROM file', []))
      })
    })
  })

  describe('scenario (e) — polymorphic discriminator (Comment)', () => {
    it('tenant-only claim: workspace-comments visible, workbench-comments hidden (no grant)', async () => {
      await withScenario(owner, { role: 'app_user', claims: { sub: OWNER_A, tenantId: TENANT_A } }, async (db) => {
        const result = await assertAllowed(
          db.query<{ id: string; subjectType: string }>(
            'SELECT id, "subjectType" FROM comment ORDER BY "subjectType"',
            []
          )
        )
        const types = result.rows.map((r) => r.subjectType).toSorted()
        // Workspace comment: tenant-scoped only — visible.
        // File comment:      tenant-scoped only — visible.
        // Workbench comment: requires workbench grant — hidden.
        expect(types).toEqual(['File', 'Workspace'])
      })
    })

    it('workbench grant via claim: workbench-comment becomes visible', async () => {
      await withScenario(
        owner,
        {
          role: 'app_user',
          claims: { sub: OWNER_A, tenantId: TENANT_A, workbenchIds: [WORKBENCH_A] },
        },
        async (db) => {
          const result = await assertAllowed(
            db.query<{ id: string; subjectType: string }>(
              'SELECT id, "subjectType" FROM comment ORDER BY "subjectType"',
              []
            )
          )
          const types = result.rows.map((r) => r.subjectType).toSorted()
          expect(types).toEqual(['File', 'Workbench', 'Workspace'])
        }
      )
    })
  })

  describe('idempotency — re-apply must be a no-op (PLAN.md DoD #2)', () => {
    it('re-running the rendered SQL leaves pg_policies and pg_roles unchanged', async () => {
      // Snapshot the canonical state observers BEFORE the second apply.
      const policiesBefore = await owner.query<{ schemaname: string; tablename: string; policyname: string }>(
        `SELECT schemaname, tablename, policyname FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname`,
        []
      )
      const rolesBefore = await owner.query<{ rolname: string }>(
        `SELECT rolname FROM pg_roles WHERE rolname IN ('app_user', 'app_system') ORDER BY rolname`,
        []
      )

      // Apply the SAME rendered SQL a second time. Every statement must
      // succeed without error (DDL is idempotently wrapped per ADR-0008).
      for (const stmt of renderedSql) {
        await owner.query(stmt)
      }

      const policiesAfter = await owner.query<{ schemaname: string; tablename: string; policyname: string }>(
        `SELECT schemaname, tablename, policyname FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname`,
        []
      )
      const rolesAfter = await owner.query<{ rolname: string }>(
        `SELECT rolname FROM pg_roles WHERE rolname IN ('app_user', 'app_system') ORDER BY rolname`,
        []
      )

      expect(policiesAfter.rows).toEqual(policiesBefore.rows)
      expect(rolesAfter.rows).toEqual(rolesBefore.rows)
    })
  })
})
