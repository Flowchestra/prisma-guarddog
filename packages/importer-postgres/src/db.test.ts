import { describe, expect, it } from 'vitest'

import { type PgQueryClient, readColumnPrivileges, readPgPolicies } from './db.js'

function clientWithRows<R extends object>(
  rows: R[]
): {
  readonly client: PgQueryClient
  readonly calls: Array<{ text: string; params: ReadonlyArray<unknown> | undefined }>
} {
  const calls: Array<{ text: string; params: ReadonlyArray<unknown> | undefined }> = []
  const client: PgQueryClient = {
    async query<T extends object = Record<string, unknown>>(
      text: string,
      params?: ReadonlyArray<unknown>
    ): Promise<{ rows: T[] }> {
      calls.push({ text, params })
      return { rows: rows as unknown as T[] }
    },
  }
  return { client, calls }
}

describe('readPgPolicies()', () => {
  it('defaults to schema=public and parameterizes the query', async () => {
    const { client, calls } = clientWithRows([])
    await readPgPolicies(client)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params).toEqual(['public'])
    expect(calls[0]!.text).toContain('FROM pg_policies')
  })

  it('honors a custom schema option', async () => {
    const { client, calls } = clientWithRows([])
    await readPgPolicies(client, { schema: 'analytics' })
    expect(calls[0]!.params).toEqual(['analytics'])
  })

  it('normalizes raw pg_policies rows into ImportedPolicyRow', async () => {
    const { client } = clientWithRows([
      {
        schemaname: 'public',
        tablename: 'workbench',
        policyname: 'workbench_app_user_select',
        permissive: 'PERMISSIVE',
        roles: ['app_user'],
        cmd: 'SELECT',
        qual: "tenant_id = current_setting('a', true)::uuid",
        with_check: null,
      },
    ])
    const rows = await readPgPolicies(client)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.policyName).toBe('workbench_app_user_select')
    expect(row.command).toBe('SELECT')
    expect(row.roles).toEqual(['app_user'])
    expect(row.permissive).toBe(true)
    expect(row.usingExpression).toContain('tenant_id')
    expect(row.withCheckExpression).toBeNull()
  })

  it('treats unrecognized cmd values as ALL', async () => {
    const { client } = clientWithRows([
      {
        schemaname: 'public',
        tablename: 't',
        policyname: 'p',
        permissive: true,
        roles: ['r'],
        cmd: 'WEIRD',
        qual: null,
        with_check: null,
      },
    ])
    const rows = await readPgPolicies(client)
    expect(rows[0]!.command).toBe('ALL')
  })
})

describe('readColumnPrivileges()', () => {
  it('filters to SELECT/INSERT/UPDATE via the query (caller can trust output verbs)', async () => {
    const { client, calls } = clientWithRows([])
    await readColumnPrivileges(client)
    expect(calls[0]!.text).toContain(`privilege_type IN ('SELECT', 'INSERT', 'UPDATE')`)
  })

  it('normalizes column-privilege rows', async () => {
    const { client } = clientWithRows([
      {
        table_schema: 'public',
        table_name: 'workbench',
        column_name: 'apiKey',
        grantee: 'app_system',
        privilege_type: 'SELECT',
      },
    ])
    const rows = await readColumnPrivileges(client)
    expect(rows).toEqual([
      {
        schema: 'public',
        table: 'workbench',
        column: 'apiKey',
        grantee: 'app_system',
        privilege: 'SELECT',
      },
    ])
  })

  it('throws on unexpected privilege types — the query should have filtered them out', async () => {
    const { client } = clientWithRows([
      {
        table_schema: 'public',
        table_name: 'workbench',
        column_name: 'apiKey',
        grantee: 'app_system',
        privilege_type: 'REFERENCES',
      },
    ])
    await expect(readColumnPrivileges(client)).rejects.toThrow(/unexpected privilege type/)
  })
})
