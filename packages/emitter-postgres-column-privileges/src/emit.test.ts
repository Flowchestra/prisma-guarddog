import type { ColumnPrivilegeAst } from '@flowchestra/prisma-guarddog-core'
import { describe, expect, it } from 'vitest'

import { emitColumnPrivileges } from './emit.js'

const ast = (input: {
  model: string
  table?: string | undefined
  columns: Record<string, { select?: readonly string[]; insert?: readonly string[]; update?: readonly string[] }>
}): ColumnPrivilegeAst =>
  Object.freeze({
    model: input.model,
    table: input.table,
    columns: Object.fromEntries(
      Object.entries(input.columns).map(([col, g]) => [
        col,
        Object.freeze({
          select: Object.freeze(g.select ?? []),
          insert: Object.freeze(g.insert ?? []),
          update: Object.freeze(g.update ?? []),
        }),
      ])
    ),
  })

describe('emitColumnPrivileges — basic GRANT emission', () => {
  it('emits SELECT/INSERT/UPDATE GRANTs for a column with all three verbs', () => {
    const sql = emitColumnPrivileges(
      ast({
        model: 'Workbench',
        columns: {
          api_key: { select: ['app_system'], insert: ['app_system'], update: ['app_system'] },
        },
      })
    )
    expect(sql).toEqual([
      'GRANT SELECT(api_key) ON workbench TO app_system;',
      'GRANT INSERT(api_key) ON workbench TO app_system;',
      'GRANT UPDATE(api_key) ON workbench TO app_system;',
    ])
  })

  it('emits one GRANT per (column, verb) with multiple roles in a single TO clause', () => {
    const sql = emitColumnPrivileges(
      ast({
        model: 'Workbench',
        columns: { api_key: { select: ['app_system', 'app_admin'] } },
      })
    )
    expect(sql).toEqual(['GRANT SELECT(api_key) ON workbench TO app_system, app_admin;'])
  })

  it('skips verbs with no granted roles', () => {
    const sql = emitColumnPrivileges(
      ast({
        model: 'Workbench',
        columns: { api_key: { select: ['app_system'], insert: [], update: [] } },
      })
    )
    expect(sql).toHaveLength(1)
    expect(sql[0]).toBe('GRANT SELECT(api_key) ON workbench TO app_system;')
  })

  it('emits in deterministic order — columns by declaration order, verbs SELECT/INSERT/UPDATE', () => {
    const sql = emitColumnPrivileges(
      ast({
        model: 'Workbench',
        columns: {
          first_col: { update: ['app_system'], select: ['app_system'] },
          second_col: { insert: ['app_system'] },
        },
      })
    )
    expect(sql).toEqual([
      'GRANT SELECT(first_col) ON workbench TO app_system;',
      'GRANT UPDATE(first_col) ON workbench TO app_system;',
      'GRANT INSERT(second_col) ON workbench TO app_system;',
    ])
  })
})

describe('emitColumnPrivileges — table-name resolution', () => {
  it('uses the table override when provided', () => {
    const sql = emitColumnPrivileges(
      ast({
        model: 'Workbench',
        table: 'public.workbenches_v2',
        columns: { api_key: { select: ['app_system'] } },
      })
    )
    expect(sql[0]).toBe('GRANT SELECT(api_key) ON "public.workbenches_v2" TO app_system;')
  })

  it('falls back to defaultTableResolver for snake_case conversion', () => {
    const sql = emitColumnPrivileges(ast({ model: 'ScopeTarget', columns: { x: { select: ['app_system'] } } }))
    expect(sql[0]).toBe('GRANT SELECT(x) ON scope_target TO app_system;')
  })

  it('honors a custom resolveTable callback', () => {
    const sql = emitColumnPrivileges(ast({ model: 'Workbench', columns: { api_key: { select: ['app_system'] } } }), {
      resolveTable: () => 'custom_t',
    })
    expect(sql[0]).toBe('GRANT SELECT(api_key) ON custom_t TO app_system;')
  })
})

describe('emitColumnPrivileges — identifier quoting', () => {
  it('quotes column names with mixed case', () => {
    const sql = emitColumnPrivileges(ast({ model: 'X', columns: { ApiKey: { select: ['app_system'] } } }))
    expect(sql[0]).toBe('GRANT SELECT("ApiKey") ON x TO app_system;')
  })

  it('quotes role names with mixed case', () => {
    const sql = emitColumnPrivileges(ast({ model: 'X', columns: { api_key: { select: ['AppSystem'] } } }))
    expect(sql[0]).toBe('GRANT SELECT(api_key) ON x TO "AppSystem";')
  })
})

describe('emitColumnPrivileges — edge cases', () => {
  it('returns an empty frozen array for an AST with no columns', () => {
    const sql = emitColumnPrivileges(ast({ model: 'X', columns: {} }))
    expect(sql).toEqual([])
    expect(Object.isFrozen(sql)).toBe(true)
  })

  it('returns an empty frozen array when all column grants are empty', () => {
    const sql = emitColumnPrivileges(
      ast({
        model: 'X',
        columns: {
          a: { select: [], insert: [], update: [] },
          b: { select: [], insert: [], update: [] },
        },
      })
    )
    expect(sql).toEqual([])
  })

  it('returned array is frozen', () => {
    const sql = emitColumnPrivileges(ast({ model: 'X', columns: { a: { select: ['app_user'] } } }))
    expect(Object.isFrozen(sql)).toBe(true)
  })
})
