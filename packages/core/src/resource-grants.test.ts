import { describe, expect, it } from 'vitest'

import { defineResourceGrants, type ResourceGrantsDefinition } from './resource-grants.js'

/**
 * Type-narrowing assertion helpers — used in place of `if (rg.source === ...)`
 * branches around `expect(...)` calls. The `vitest/no-conditional-expect`
 * lint rule wants assertions to be unconditionally reached; these helpers
 * throw on the wrong branch, so the subsequent expects run on the narrowed
 * type without an if-wrapper.
 */
function asClaims<T extends string>(
  rg: ResourceGrantsDefinition<T>
): Extract<ResourceGrantsDefinition<T>, { source: 'claims' }> {
  if (rg.source !== 'claims') throw new Error(`expected source: "claims", got "${rg.source}"`)
  return rg
}
function asTable<T extends string>(
  rg: ResourceGrantsDefinition<T>
): Extract<ResourceGrantsDefinition<T>, { source: 'table' }> {
  if (rg.source !== 'table') throw new Error(`expected source: "table", got "${rg.source}"`)
  return rg
}

describe('defineResourceGrants — source: "claims" (default)', () => {
  it('captures the action vocabulary and freezes the definition', () => {
    const rg = defineResourceGrants({
      actions: ['read', 'write', 'edit', 'delete'] as const,
    })
    const claims = asClaims(rg)
    expect(claims.actions).toEqual(['read', 'write', 'edit', 'delete'])
    expect(claims.source).toBe('claims')
    expect(claims.claimPath).toBe('grants')
    expect(Object.isFrozen(claims)).toBe(true)
    expect(Object.isFrozen(claims.actions)).toBe(true)
  })

  it('defaults source to "claims"', () => {
    const rg = defineResourceGrants({ actions: ['read'] as const })
    expect(rg.source).toBe('claims')
  })

  it('defaults claimPath to "grants"', () => {
    const claims = asClaims(defineResourceGrants({ actions: ['read'] as const }))
    expect(claims.claimPath).toBe('grants')
  })

  it('honors a custom claimPath', () => {
    const claims = asClaims(
      defineResourceGrants({
        claimPath: 'permissions',
        actions: ['read'] as const,
      })
    )
    expect(claims.claimPath).toBe('permissions')
  })

  it('infers a literal-union TActions from the input array (const-typed)', () => {
    const rg = defineResourceGrants({ actions: ['a', 'b', 'c'] as const })
    const _check: ResourceGrantsDefinition<'a' | 'b' | 'c'> = rg
    void _check
    expect(rg.actions).toEqual(['a', 'b', 'c'])
  })

  it('rejects an empty actions array', () => {
    expect(() => defineResourceGrants({ actions: [] })).toThrow(/actions must be a non-empty array/)
  })

  it('rejects empty action names', () => {
    expect(() => defineResourceGrants({ actions: ['read', ''] })).toThrow(/action names must be non-empty strings/)
  })

  it('rejects duplicate actions', () => {
    expect(() => defineResourceGrants({ actions: ['read', 'write', 'read'] })).toThrow(/duplicate action "read"/)
  })

  it('rejects an empty claimPath', () => {
    expect(() => defineResourceGrants({ claimPath: '', actions: ['read'] })).toThrow(
      /claimPath must be a non-empty string/
    )
  })
})

describe('defineResourceGrants — source: "table" (per-resource tables)', () => {
  it('accepts a per-resource entry with actionsColumn (text[] storage)', () => {
    const table = asTable(
      defineResourceGrants({
        source: 'table',
        actions: ['edit', 'admin'] as const,
        tables: {
          workspaceId: {
            name: 'workspace_grant',
            principalColumn: 'userId',
            actionsColumn: 'actions',
          },
        },
      })
    )
    expect(table.source).toBe('table')
    expect(table.tables['workspaceId']?.name).toBe('workspace_grant')
    expect(table.tables['workspaceId']?.actionsColumn).toBe('actions')
    expect(table.principalClaim).toBe('sub')
    expect(table.fallbackTable).toBeUndefined()
  })

  it('accepts a per-resource entry with actionColumn (one row per action)', () => {
    const table = asTable(
      defineResourceGrants({
        source: 'table',
        actions: ['edit'] as const,
        tables: {
          workspaceId: {
            name: 'workspace_grant',
            principalColumn: 'userId',
            actionColumn: 'action',
          },
        },
      })
    )
    expect(table.tables['workspaceId']?.actionColumn).toBe('action')
    expect(table.tables['workspaceId']?.actionsColumn).toBeUndefined()
  })

  it('honors a custom principalClaim', () => {
    const table = asTable(
      defineResourceGrants({
        source: 'table',
        actions: ['edit'] as const,
        principalClaim: 'userId',
        tables: {
          workspaceId: { name: 'workspace_grant', principalColumn: 'userId', actionsColumn: 'actions' },
        },
      })
    )
    expect(table.principalClaim).toBe('userId')
  })

  it('rejects neither actionColumn nor actionsColumn', () => {
    expect(() =>
      defineResourceGrants({
        source: 'table',
        actions: ['edit'] as const,
        tables: {
          workspaceId: { name: 'workspace_grant', principalColumn: 'userId' },
        },
      })
    ).toThrow(/exactly one of `actionColumn` .* or `actionsColumn` .* must be set.*Neither is set/)
  })

  it('rejects both actionColumn and actionsColumn together', () => {
    expect(() =>
      defineResourceGrants({
        source: 'table',
        actions: ['edit'] as const,
        tables: {
          workspaceId: {
            name: 'workspace_grant',
            principalColumn: 'userId',
            actionColumn: 'action',
            actionsColumn: 'actions',
          },
        },
      })
    ).toThrow(/Both are currently set/)
  })

  it('rejects empty table name', () => {
    expect(() =>
      defineResourceGrants({
        source: 'table',
        actions: ['edit'] as const,
        tables: {
          workspaceId: { name: '', principalColumn: 'userId', actionsColumn: 'actions' },
        },
      })
    ).toThrow(/name must be a non-empty string/)
  })

  it('rejects empty scope-column keys', () => {
    expect(() =>
      defineResourceGrants({
        source: 'table',
        actions: ['edit'] as const,
        tables: {
          '': { name: 'workspace_grant', principalColumn: 'userId', actionsColumn: 'actions' },
        },
      })
    ).toThrow(/tables\{\} keys .* must be non-empty strings/)
  })

  it('rejects empty principalClaim', () => {
    expect(() =>
      defineResourceGrants({
        source: 'table',
        actions: ['edit'] as const,
        principalClaim: '',
        tables: {
          workspaceId: { name: 'workspace_grant', principalColumn: 'userId', actionsColumn: 'actions' },
        },
      })
    ).toThrow(/principalClaim must be a non-empty string/)
  })

  it('rejects neither tables nor fallbackTable', () => {
    expect(() =>
      defineResourceGrants({
        source: 'table',
        actions: ['edit'] as const,
      })
    ).toThrow(/must declare at least one of `tables` .* or `fallbackTable`/)
  })
})

describe('defineResourceGrants — source: "table" (polymorphic fallback)', () => {
  it('accepts a fallbackTable with scopeColumnTypeMap', () => {
    const table = asTable(
      defineResourceGrants({
        source: 'table',
        actions: ['edit'] as const,
        fallbackTable: {
          name: 'resource_grant',
          principalColumn: 'userId',
          resourceTypeColumn: 'resourceType',
          resourceIdColumn: 'resourceId',
          actionsColumn: 'actions',
          scopeColumnTypeMap: { tenantId: 'Tenant', orgId: 'Org' },
        },
      })
    )
    expect(table.fallbackTable?.name).toBe('resource_grant')
    expect(table.fallbackTable?.scopeColumnTypeMap['tenantId']).toBe('Tenant')
  })

  it('rejects fallbackTable with empty scopeColumnTypeMap', () => {
    expect(() =>
      defineResourceGrants({
        source: 'table',
        actions: ['edit'] as const,
        fallbackTable: {
          name: 'resource_grant',
          principalColumn: 'userId',
          resourceTypeColumn: 'resourceType',
          resourceIdColumn: 'resourceId',
          actionsColumn: 'actions',
          scopeColumnTypeMap: {},
        },
      })
    ).toThrow(/scopeColumnTypeMap must declare at least one .* entry/)
  })

  it('rejects fallbackTable with neither actionColumn nor actionsColumn', () => {
    expect(() =>
      defineResourceGrants({
        source: 'table',
        actions: ['edit'] as const,
        fallbackTable: {
          name: 'resource_grant',
          principalColumn: 'userId',
          resourceTypeColumn: 'resourceType',
          resourceIdColumn: 'resourceId',
          scopeColumnTypeMap: { tenantId: 'Tenant' },
        },
      })
    ).toThrow(/exactly one of `actionColumn` or `actionsColumn` must be set/)
  })

  it('accepts both per-resource tables and a polymorphic fallback together', () => {
    const table = asTable(
      defineResourceGrants({
        source: 'table',
        actions: ['edit'] as const,
        tables: {
          workspaceId: { name: 'workspace_grant', principalColumn: 'userId', actionsColumn: 'actions' },
        },
        fallbackTable: {
          name: 'resource_grant',
          principalColumn: 'userId',
          resourceTypeColumn: 'resourceType',
          resourceIdColumn: 'resourceId',
          actionsColumn: 'actions',
          scopeColumnTypeMap: { tenantId: 'Tenant' },
        },
      })
    )
    expect(Object.keys(table.tables)).toEqual(['workspaceId'])
    expect(table.fallbackTable?.name).toBe('resource_grant')
  })
})
