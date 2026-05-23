/**
 * `@prisma-guarddog/testing-postgres` — RLS verification harness.
 *
 * Real Postgres only (ADR-0013). Each scenario opens a transaction,
 * installs a test identity via `SET LOCAL ROLE` + claims, runs assertion
 * helpers, then `ROLLBACK`s — so tests are hermetic without external
 * cleanup.
 *
 *   await withScenario(client, { role: 'app_user', claims: { tenantId: 'A' } }, async (db) => {
 *     await assertAllowed(db.query('SELECT * FROM workbench WHERE tenant_id = $1', ['A']))
 *     await assertDenied(db.query('INSERT INTO workbench (...) VALUES (...)'))
 *   })
 */

export type { PgSessionClient } from './client.js'

export { DEFAULT_CLAIMS_ACCESSOR, withScenario } from './session.js'
export type { SessionOptions } from './session.js'

export { assertAllowed, assertDenied, assertHiddenColumns, AssertionError, assertVisibleRows } from './asserts.js'
export type { AssertDeniedOptions } from './asserts.js'
