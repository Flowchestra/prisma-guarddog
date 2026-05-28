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
    ).toThrow(
      /exactly one of `actionsColumn` .* `actionColumn` .* or `roleColumn` .* must be set\. 0 are currently set/
    )
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
    ).toThrow(
      /exactly one of `actionsColumn` .* `actionColumn` .* or `roleColumn` .* must be set\. 2 are currently set/
    )
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
    ).toThrow(/exactly one of `actionsColumn` .* `actionColumn` .* or `roleColumn` .* must be set/)
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

describe('defineResourceGrants — source: "table" (rank-based, issue #5)', () => {
  it('accepts roleColumn + roleHierarchy and preserves them', () => {
    const table = asTable(
      defineResourceGrants({
        source: 'table',
        actions: ['READER', 'EDITOR', 'MANAGER', 'OWNER'] as const,
        tables: {
          workspaceId: {
            name: 'workspace_grants',
            principalColumn: 'user_id',
            roleColumn: 'role',
            roleHierarchy: ['READER', 'EDITOR', 'MANAGER', 'OWNER'],
            roleColumnType: '"ResourceRole"',
          },
        },
      })
    )
    const entry = table.tables['workspaceId']
    expect(entry?.roleColumn).toBe('role')
    expect(entry?.roleHierarchy).toEqual(['READER', 'EDITOR', 'MANAGER', 'OWNER'])
    expect(entry?.roleColumnType).toBe('"ResourceRole"')
  })

  it('rejects roleColumn without roleHierarchy', () => {
    expect(() =>
      defineResourceGrants({
        source: 'table',
        actions: ['READER', 'EDITOR'] as const,
        tables: { workspaceId: { name: 'g', principalColumn: 'user_id', roleColumn: 'role' } },
      })
    ).toThrow(/`roleColumn` requires a non-empty `roleHierarchy`/)
  })

  it('rejects a roleHierarchy entry not in the declared actions vocabulary', () => {
    expect(() =>
      defineResourceGrants({
        source: 'table',
        actions: ['READER', 'EDITOR'] as const,
        tables: {
          workspaceId: {
            name: 'g',
            principalColumn: 'user_id',
            roleColumn: 'role',
            roleHierarchy: ['READER', 'EDITOR', 'MANAGER'], // MANAGER not in actions
          },
        },
      })
    ).toThrow(/roleHierarchy entry "MANAGER" is not in the declared `actions` vocabulary/)
  })

  it('rejects more than one action shape (roleColumn + actionsColumn)', () => {
    expect(() =>
      defineResourceGrants({
        source: 'table',
        actions: ['READER'] as const,
        tables: {
          workspaceId: {
            name: 'g',
            principalColumn: 'user_id',
            roleColumn: 'role',
            roleHierarchy: ['READER'],
            actionsColumn: 'actions',
          },
        },
      })
    ).toThrow(/exactly one of .* must be set\. 2 are currently set/)
  })

  it('rejects roleHierarchy without roleColumn', () => {
    expect(() =>
      defineResourceGrants({
        source: 'table',
        actions: ['READER'] as const,
        tables: {
          workspaceId: { name: 'g', principalColumn: 'user_id', actionsColumn: 'actions', roleHierarchy: ['READER'] },
        },
      })
    ).toThrow(/`roleHierarchy` \/ `roleColumnType` are only valid alongside `roleColumn`/)
  })
})

describe('defineResourceGrants — source: "table" (principal disjunction, issue #6)', () => {
  it('accepts principalUserColumn + principalGroupColumn + groupMemberTable', () => {
    const table = asTable(
      defineResourceGrants({
        source: 'table',
        actions: ['edit'] as const,
        tables: {
          workspaceId: {
            name: 'workspace_grants',
            principalUserColumn: 'user_id',
            principalGroupColumn: 'group_id',
            groupMemberTable: { name: 'org_group_members', userColumn: 'user_id', groupColumn: 'group_id' },
            actionsColumn: 'actions',
          },
        },
      })
    )
    const entry = table.tables['workspaceId']
    expect(entry?.principalUserColumn).toBe('user_id')
    expect(entry?.principalGroupColumn).toBe('group_id')
    expect(entry?.groupMemberTable?.name).toBe('org_group_members')
  })

  it('rejects both principalColumn and principalUserColumn (aliases)', () => {
    expect(() =>
      defineResourceGrants({
        source: 'table',
        actions: ['edit'] as const,
        tables: {
          workspaceId: {
            name: 'g',
            principalColumn: 'user_id',
            principalUserColumn: 'user_id',
            actionsColumn: 'actions',
          },
        },
      })
    ).toThrow(/set either `principalColumn` or `principalUserColumn` .* not both/)
  })

  it('rejects neither principalColumn nor principalUserColumn', () => {
    expect(() =>
      defineResourceGrants({
        source: 'table',
        actions: ['edit'] as const,
        tables: {
          workspaceId: { name: 'g', actionsColumn: 'actions' },
        },
      })
    ).toThrow(/a user principal column is required/)
  })

  it('rejects principalGroupColumn without groupMemberTable', () => {
    expect(() =>
      defineResourceGrants({
        source: 'table',
        actions: ['edit'] as const,
        tables: {
          workspaceId: {
            name: 'g',
            principalUserColumn: 'user_id',
            principalGroupColumn: 'group_id',
            actionsColumn: 'actions',
          },
        },
      })
    ).toThrow(/`principalGroupColumn` and `groupMemberTable` must be declared together.*groupMemberTable is missing/)
  })

  it('rejects groupMemberTable without principalGroupColumn', () => {
    expect(() =>
      defineResourceGrants({
        source: 'table',
        actions: ['edit'] as const,
        tables: {
          workspaceId: {
            name: 'g',
            principalUserColumn: 'user_id',
            groupMemberTable: { name: 'org_group_members', userColumn: 'user_id', groupColumn: 'group_id' },
            actionsColumn: 'actions',
          },
        },
      })
    ).toThrow(/must be declared together.*principalGroupColumn is missing/)
  })
})
