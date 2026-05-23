/**
 * Scenario wrapper: open a transaction, install a test identity (role +
 * claims), run the assertion body, ROLLBACK.
 *
 * Per ADR-0013 the harness only works against a real Postgres connection
 * (`pg-mem` and friends do not implement enough of `SET ROLE` /
 * `current_setting` / column GRANTs to give honest signal). The transaction
 * boundary keeps tests hermetic — each scenario starts from a known
 * baseline and leaves no trace.
 *
 * `withScenario` accepts any pg-compatible client (`pg.Client`,
 * `pg.PoolClient`, anything with `.query`). For a `pg.Pool` you'd
 * `pool.connect()` first so all queries hit the same session.
 *
 * The `SET LOCAL` statements use the parameterized form so claim payloads
 * containing single quotes can't break out of the literal — Postgres
 * accepts a value via `SELECT set_config('key', $1, true)` which is
 * functionally equivalent to `SET LOCAL` but parameter-safe.
 */

import type { PgSessionClient } from './client.js'

export interface SessionOptions {
  /** Postgres role to set for the scenario via `SET LOCAL ROLE`. */
  readonly role: string
  /**
   * Claims payload installed via `set_config(claimsAccessor, ..., true)`.
   * Strings are passed through verbatim; objects are JSON-serialized.
   * Omit to leave whatever claim payload (if any) the calling code set.
   */
  readonly claims?: object | string
  /**
   * `current_setting()` key to write claims into. Defaults to the canonical
   * Supabase / PostgREST path `request.jwt.claims`.
   */
  readonly claimsAccessor?: string
}

export const DEFAULT_CLAIMS_ACCESSOR = 'request.jwt.claims'

/**
 * Run `fn` inside `BEGIN; SET LOCAL ROLE ...; SET LOCAL request.jwt.claims = ...;`
 * then `ROLLBACK` regardless of outcome. The body receives the same client
 * so any `client.query(...)` inside it inherits the session's role and
 * claims.
 *
 * Errors thrown by `fn` propagate after the rollback completes; the
 * rollback itself is best-effort and any error from it is swallowed
 * because it would mask the more interesting body error.
 */
export async function withScenario<R>(
  client: PgSessionClient,
  opts: SessionOptions,
  fn: (db: PgSessionClient) => Promise<R>
): Promise<R> {
  await client.query('BEGIN', [])
  try {
    await client.query('SELECT set_config($1, $2, true)', ['role', opts.role])
    if (opts.claims !== undefined) {
      const accessor = opts.claimsAccessor ?? DEFAULT_CLAIMS_ACCESSOR
      const serialized = typeof opts.claims === 'string' ? opts.claims : JSON.stringify(opts.claims)
      await client.query('SELECT set_config($1, $2, true)', [accessor, serialized])
    }
    const result = await fn(client)
    await safeRollback(client)
    return result
  } catch (err) {
    await safeRollback(client)
    throw err
  }
}

async function safeRollback(client: PgSessionClient): Promise<void> {
  try {
    await client.query('ROLLBACK', [])
  } catch {
    // The rollback may fail (e.g., connection was severed mid-scenario).
    // Surface the original body error instead — swallowing the rollback
    // error keeps the failure signal aligned with what the test author
    // was checking.
  }
}
