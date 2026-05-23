import { describe, expect, it } from 'vitest'

import { assertAllowed, assertDenied, assertHiddenColumns, AssertionError, assertVisibleRows } from './asserts.js'

describe('assertAllowed()', () => {
  it('returns the resolved value when the promise succeeds', async () => {
    const value = await assertAllowed(Promise.resolve(42))
    expect(value).toBe(42)
  })

  it('rethrows as an AssertionError when the promise rejects', async () => {
    const p = Promise.reject(new Error('boom'))
    await expect(assertAllowed(p)).rejects.toBeInstanceOf(AssertionError)
    await expect(assertAllowed(Promise.reject(new Error('detail')))).rejects.toThrow(
      /expected operation to be allowed.*detail/
    )
  })
})

describe('assertDenied()', () => {
  it('passes when the promise rejects with a Postgres RLS error', async () => {
    await assertDenied(Promise.reject(new Error('new row violates row-level security policy for table "workbench"')))
  })

  it('passes for permission-denied errors too (column GRANT revocation)', async () => {
    await assertDenied(Promise.reject(new Error('permission denied for relation workbench')))
  })

  it('fails when the promise resolves', async () => {
    await expect(assertDenied(Promise.resolve({ ok: true }))).rejects.toThrow(/expected operation to be denied/)
  })

  it('fails when the rejection message does not match the denial pattern', async () => {
    await expect(assertDenied(Promise.reject(new Error('connection refused')))).rejects.toThrow(/unexpected error/)
  })

  it('honors a custom pattern', async () => {
    await assertDenied(Promise.reject(new Error('CUSTOM_DENIAL_TAG')), { pattern: /CUSTOM_DENIAL_TAG/ })
  })
})

describe('assertVisibleRows()', () => {
  it('passes when the row count matches', () => {
    assertVisibleRows({ rows: [{ a: 1 }, { a: 2 }] }, 2)
  })

  it('throws an AssertionError on mismatch', () => {
    expect(() => assertVisibleRows({ rows: [] }, 3)).toThrow(/expected 3 visible rows, got 0/)
  })
})

describe('assertHiddenColumns()', () => {
  it('passes when every named column is null or undefined', () => {
    assertHiddenColumns({ apiKey: null, otherField: 'visible' }, ['apiKey', 'absent'])
  })

  it('throws when any named column is populated', () => {
    expect(() => assertHiddenColumns({ apiKey: 'secret' }, ['apiKey'])).toThrow(/apiKey/)
  })
})
