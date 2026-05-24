import { describe, expect, it } from 'vitest'

import { runImport } from './import.js'

describe('runImport (connection failure path)', () => {
  // The happy path requires a live Postgres database and lives in the
  // importer-postgres package's own integration suite. Here we only verify
  // the CLI's failure semantics: a bad URL surfaces a useful diagnostic
  // and returns ok=false. The connection attempt against an unreachable
  // local port is fast (ECONNREFUSED) and doesn't hang.
  it('returns ok=false with a redacted URL diagnostic for an unreachable host', async () => {
    const result = await runImport({
      url: 'postgres://user:secret@127.0.0.1:1/guarddog_does_not_exist',
      stderr: false,
    })
    expect(result.ok).toBe(false)
    expect(result.diagnostics[0]).toMatch(/failed to connect/)
    // Credentials must not leak into diagnostics.
    expect(result.diagnostics[0]).not.toContain('secret')
  })
})
