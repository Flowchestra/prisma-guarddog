/**
 * Assertion helpers for RLS scenario tests.
 *
 *   - `assertAllowed(promise)`       — passes if `promise` resolves; returns its value.
 *   - `assertDenied(promise, opts?)` — passes if `promise` rejects with a Postgres
 *                                       row-level-security / privilege error.
 *   - `assertVisibleRows(rs, n)`     — passes if a query result has exactly `n` rows.
 *   - `assertHiddenColumns(row, cs)` — passes if every column in `cs` is missing or null.
 *
 * `assertDenied`'s default error pattern catches the family of Postgres
 * messages an RLS denial actually produces: row-level-security policy
 * rejections, permission-denied errors on tables / columns, and the
 * "violates check constraint" form that `WITH CHECK` clauses raise.
 * Override `pattern` to narrow when a test cares which family of error
 * a particular policy should surface.
 */

const DEFAULT_DENIAL_PATTERN =
  /permission denied|row-level security policy|new row violates row-level security|violates check constraint/i

export interface AssertDeniedOptions {
  /**
   * Override the message pattern used to recognise a denial. Defaults
   * to the union of Postgres' standard RLS / privilege denial phrasings.
   */
  readonly pattern?: RegExp
}

/**
 * Pass through a promise that should resolve. If the promise rejects, the
 * underlying error is rethrown with a "expected to be allowed" prefix so
 * the test failure points at the assertion, not just the raw DB error.
 */
export async function assertAllowed<R>(promise: Promise<R>): Promise<R> {
  try {
    return await promise
  } catch (err) {
    const detail = (err as Error).message ?? String(err)
    throw new AssertionError(`expected operation to be allowed, but it failed: ${detail}`)
  }
}

/**
 * Pass if `promise` rejects with an error whose message matches the
 * denial pattern. If `promise` resolves, fail with a "was allowed but
 * should have been denied" message.
 */
export async function assertDenied(promise: Promise<unknown>, opts: AssertDeniedOptions = {}): Promise<void> {
  const pattern = opts.pattern ?? DEFAULT_DENIAL_PATTERN
  let resolved: { value: unknown } | undefined
  try {
    const value = await promise
    resolved = { value }
  } catch (err) {
    const detail = (err as Error).message ?? String(err)
    if (!pattern.test(detail)) {
      throw new AssertionError(`operation was denied, but with an unexpected error: ${detail}`)
    }
    return
  }
  throw new AssertionError(
    `expected operation to be denied (pattern ${pattern.source}), but it succeeded with: ${formatValue(resolved.value)}`
  )
}

/**
 * Pass if `result.rows.length === expected`. Works for any `{ rows: ... }`
 * shape — `pg.Client.query` returns one, and so does the fake test client.
 */
export function assertVisibleRows<R>(result: { readonly rows: ReadonlyArray<R> }, expected: number): void {
  if (result.rows.length !== expected) {
    throw new AssertionError(`expected ${expected} visible rows, got ${result.rows.length}`)
  }
}

/**
 * Pass if every column in `columns` is either missing from `row` or set
 * to `null`. Useful for verifying column-level `REVOKE` (Postgres returns
 * NULL for revoked columns in a `SELECT *`, not an error).
 */
export function assertHiddenColumns(row: Readonly<Record<string, unknown>>, columns: ReadonlyArray<string>): void {
  const visible = columns.filter((c) => row[c] !== undefined && row[c] !== null)
  if (visible.length > 0) {
    throw new AssertionError(`expected columns to be hidden but they are populated: ${visible.join(', ')}`)
  }
}

/**
 * Distinct error type so test frameworks (vitest, jest) format harness
 * failures the same way they format other expectation failures, and so
 * users can `catch` them without confusing them with DB errors.
 */
export class AssertionError extends Error {
  constructor(message: string) {
    super(`[prisma-guarddog/testing-postgres] ${message}`)
    this.name = 'AssertionError'
  }
}

function formatValue(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
