import { describe, expect, it } from 'vitest'

import type { PgSessionClient } from './client.js'
import { DEFAULT_CLAIMS_ACCESSOR, withScenario } from './session.js'

interface RecordedCall {
  readonly text: string
  readonly params: ReadonlyArray<unknown> | undefined
}

function recordingClient(opts: { rollbackThrows?: boolean } = {}): {
  readonly client: PgSessionClient
  readonly calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const client: PgSessionClient = {
    async query<R extends object = Record<string, unknown>>(
      text: string,
      params?: ReadonlyArray<unknown>
    ): Promise<{ rows: R[] }> {
      calls.push({ text, params })
      if (opts.rollbackThrows && text === 'ROLLBACK') throw new Error('rollback boom')
      return { rows: [] }
    },
  }
  return { client, calls }
}

describe('withScenario()', () => {
  it('opens a transaction, sets role and claims, runs fn, and rolls back', async () => {
    const { client, calls } = recordingClient()
    const result = await withScenario(client, { role: 'app_user', claims: { tenantId: 'A' } }, async (db) => {
      await db.query('SELECT 1', [])
      return 'ok' as const
    })
    expect(result).toBe('ok')
    const texts = calls.map((c) => c.text)
    expect(texts).toEqual([
      'BEGIN',
      'SELECT set_config($1, $2, true)',
      'SELECT set_config($1, $2, true)',
      'SELECT 1',
      'ROLLBACK',
    ])
    expect(calls[1]!.params).toEqual(['role', 'app_user'])
    expect(calls[2]!.params).toEqual([DEFAULT_CLAIMS_ACCESSOR, JSON.stringify({ tenantId: 'A' })])
  })

  it('skips the claims set_config call when no claims are provided', async () => {
    const { client, calls } = recordingClient()
    await withScenario(client, { role: 'app_user' }, async () => {})
    const setConfigCalls = calls.filter((c) => c.text === 'SELECT set_config($1, $2, true)')
    expect(setConfigCalls).toHaveLength(1)
    expect(setConfigCalls[0]!.params).toEqual(['role', 'app_user'])
  })

  it('respects a custom claimsAccessor', async () => {
    const { client, calls } = recordingClient()
    await withScenario(
      client,
      { role: 'app_user', claims: { tenantId: 'A' }, claimsAccessor: 'my.claims' },
      async () => {}
    )
    const claimsCall = calls.find((c) => c.params?.[0] === 'my.claims')
    expect(claimsCall).toBeDefined()
  })

  it('passes a string claims payload through verbatim', async () => {
    const { client, calls } = recordingClient()
    const literal = '{"tenantId":"A"}'
    await withScenario(client, { role: 'app_user', claims: literal }, async () => {})
    const claimsCall = calls.find((c) => c.params?.[0] === DEFAULT_CLAIMS_ACCESSOR)
    expect(claimsCall?.params?.[1]).toBe(literal)
  })

  it('rolls back and rethrows when the body throws', async () => {
    const { client, calls } = recordingClient()
    await expect(
      withScenario(client, { role: 'app_user' }, async () => {
        throw new Error('body boom')
      })
    ).rejects.toThrow(/body boom/)
    expect(calls[calls.length - 1]!.text).toBe('ROLLBACK')
  })

  it('still rethrows the body error when ROLLBACK itself fails', async () => {
    const { client } = recordingClient({ rollbackThrows: true })
    await expect(
      withScenario(client, { role: 'app_user' }, async () => {
        throw new Error('body boom')
      })
    ).rejects.toThrow(/body boom/)
  })
})
