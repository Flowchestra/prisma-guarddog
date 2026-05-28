import { defineClaims, defineResourceGrants } from '@flowchestra/prisma-guarddog-core'
import type { ClaimsDefinition, Expr, LiteralValue } from '@flowchestra/prisma-guarddog-core'
import { describe, expect, it } from 'vitest'

import {
  compileExpr,
  defaultCompileHasAppRole,
  defaultCompileHasGrant,
  defaultCompileIsOwner,
  type ExprCompileCtx,
} from './compile-expr.js'

const claims: ClaimsDefinition = defineClaims({
  accessor: 'request.jwt.claims',
  shape: (c) => ({
    sub: c.uuid(),
    tenantId: c.uuid(),
    workspaceIds: c.array(c.uuid()),
    roles: c.array(c.string()),
    age: c.integer(),
    active: c.boolean(),
  }),
})

const baseCtx = (overrides: Partial<ExprCompileCtx> = {}): ExprCompileCtx => ({
  table: 'workbench',
  qualifyColumns: false,
  claims,
  ...overrides,
})

const literal = (value: LiteralValue): Expr => Object.freeze({ kind: 'literal', value }) as Expr
const col = (column: string): Expr => Object.freeze({ kind: 'col', column }) as Expr
const claim = (path: string): Expr => Object.freeze({ kind: 'claim', path }) as Expr
const and = (...operands: Expr[]): Expr => Object.freeze({ kind: 'and', operands: Object.freeze(operands) }) as Expr
const or = (...operands: Expr[]): Expr => Object.freeze({ kind: 'or', operands: Object.freeze(operands) }) as Expr
const not = (operand: Expr): Expr => Object.freeze({ kind: 'not', operand }) as Expr
const binop = (op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte', left: Expr, right: Expr): Expr =>
  Object.freeze({ kind: 'binop', op, left, right }) as Expr
const hasAppRole = (role: string): Expr => Object.freeze({ kind: 'hasAppRole', role }) as Expr
const hasGrant = (action: string, scopeColumn: string): Expr =>
  Object.freeze({ kind: 'hasGrant', action, scopeColumn }) as Expr
const hasResourcePermission = (action: string, jsonbColumn: string): Expr =>
  Object.freeze({ kind: 'hasResourcePermission', action, jsonbColumn }) as Expr
const isOwner = (ownerColumn: string): Expr => Object.freeze({ kind: 'isOwner', ownerColumn }) as Expr
const inArray = (needle: Expr, haystack: Expr): Expr => Object.freeze({ kind: 'inArray', needle, haystack }) as Expr
const raw = (sql: string): Expr => Object.freeze({ kind: 'raw', sql }) as Expr

describe('compileExpr — leaves', () => {
  it('compiles literals', () => {
    const ctx = baseCtx()
    expect(compileExpr(literal('hi'), ctx)).toBe("'hi'")
    expect(compileExpr(literal(42), ctx)).toBe('42')
    expect(compileExpr(literal(true), ctx)).toBe('TRUE')
    expect(compileExpr(literal(null), ctx)).toBe('NULL')
  })

  it('compiles columns unqualified by default', () => {
    expect(compileExpr(col('tenant_id'), baseCtx())).toBe('tenant_id')
  })

  it('quotes columns with uppercase or special chars', () => {
    expect(compileExpr(col('TenantId'), baseCtx())).toBe('"TenantId"')
  })

  it('qualifies columns when ctx.qualifyColumns is true', () => {
    expect(compileExpr(col('tenant_id'), baseCtx({ qualifyColumns: true }))).toBe('workbench.tenant_id')
  })
})

describe('compileExpr — claim', () => {
  it('scalar uuid claim casts to uuid', () => {
    expect(compileExpr(claim('tenantId'), baseCtx())).toBe(
      "((current_setting('request.jwt.claims', true)::json ->> 'tenantId'))::uuid"
    )
  })

  it('scalar integer claim casts to integer', () => {
    expect(compileExpr(claim('age'), baseCtx())).toBe(
      "((current_setting('request.jwt.claims', true)::json ->> 'age'))::integer"
    )
  })

  it('scalar boolean claim casts to boolean', () => {
    expect(compileExpr(claim('active'), baseCtx())).toBe(
      "((current_setting('request.jwt.claims', true)::json ->> 'active'))::boolean"
    )
  })

  it('array claim returns jsonb form (no cast)', () => {
    expect(compileExpr(claim('workspaceIds'), baseCtx())).toBe(
      "(current_setting('request.jwt.claims', true)::jsonb -> 'workspaceIds')"
    )
  })

  it('throws on unknown claim', () => {
    expect(() => compileExpr(claim('ghost'), baseCtx())).toThrow(/unknown claim "ghost"/)
  })
})

describe('compileExpr — binops and logical', () => {
  it.each([
    ['eq', '='],
    ['neq', '<>'],
    ['lt', '<'],
    ['lte', '<='],
    ['gt', '>'],
    ['gte', '>='],
  ] as const)('compiles %s as %s', (op, sql) => {
    expect(compileExpr(binop(op, col('a'), col('b')), baseCtx())).toBe(`(a ${sql} b)`)
  })

  it('compiles AND with two operands', () => {
    expect(compileExpr(and(col('a'), col('b')), baseCtx())).toBe('(a AND b)')
  })

  it('compiles AND with three operands', () => {
    expect(compileExpr(and(col('a'), col('b'), col('c')), baseCtx())).toBe('(a AND b AND c)')
  })

  it('compiles AND with zero operands as TRUE', () => {
    expect(compileExpr(and(), baseCtx())).toBe('TRUE')
  })

  it('compiles AND with one operand as that operand', () => {
    expect(compileExpr(and(col('only')), baseCtx())).toBe('only')
  })

  it('compiles OR with zero operands as FALSE', () => {
    expect(compileExpr(or(), baseCtx())).toBe('FALSE')
  })

  it('compiles OR with two operands', () => {
    expect(compileExpr(or(col('a'), col('b')), baseCtx())).toBe('(a OR b)')
  })

  it('compiles NOT', () => {
    expect(compileExpr(not(col('a')), baseCtx())).toBe('(NOT a)')
  })
})

describe('compileExpr — hasAppRole (layer 2)', () => {
  it('compiles via jsonb ? operator on the roles claim', () => {
    expect(compileExpr(hasAppRole('workspace.admin'), baseCtx())).toBe(
      "((current_setting('request.jwt.claims', true)::jsonb -> 'roles') ? 'workspace.admin')"
    )
  })

  it('output never references app.* or any consumer-side helper', () => {
    const sql = compileExpr(hasAppRole('workspace.admin'), baseCtx())
    expect(sql).not.toMatch(/\bapp\./)
    expect(sql).toContain('current_setting')
  })

  it('honors an overridden compileHasAppRole', () => {
    const custom = compileExpr(hasAppRole('x'), baseCtx({ compileHasAppRole: () => 'CUSTOM' }))
    expect(custom).toBe('CUSTOM')
  })
})

describe('compileExpr — hasGrant (layer 3)', () => {
  it('compiles inline against the default "grants" claim path', () => {
    expect(compileExpr(hasGrant('edit', 'workspace_id'), baseCtx({ qualifyColumns: true }))).toBe(
      "((current_setting('request.jwt.claims', true)::jsonb -> 'grants' -> 'edit') ? (workbench.workspace_id)::text)"
    )
  })

  it('uses the configured resourceGrants.claimPath when present', () => {
    const ctx = baseCtx({
      qualifyColumns: true,
      resourceGrants: {
        source: 'claims',
        claimPath: 'permissions',
        actions: ['edit'],
        principalClaim: 'sub',
      },
    })
    expect(compileExpr(hasGrant('edit', 'workspace_id'), ctx)).toContain("'permissions' -> 'edit'")
  })

  it('output never references app.* or any consumer-side helper', () => {
    const sql = compileExpr(hasGrant('edit', 'workspace_id'), baseCtx())
    expect(sql).not.toMatch(/\bapp\./)
  })

  it('honors an overridden compileHasGrant', () => {
    const custom = compileExpr(hasGrant('edit', 'x'), baseCtx({ compileHasGrant: () => 'CUSTOM' }))
    expect(custom).toBe('CUSTOM')
  })
})

describe('compileExpr — hasResourcePermission (per-resource jsonb)', () => {
  it('compiles inline against the users.<sub> path in the jsonb column', () => {
    expect(compileExpr(hasResourcePermission('read', 'permissions'), baseCtx({ qualifyColumns: true }))).toBe(
      "((workbench.permissions -> 'users' -> (current_setting('request.jwt.claims', true)::json ->> 'sub')) ? 'read')"
    )
  })

  it('output never references app.* or any consumer-side helper', () => {
    const sql = compileExpr(hasResourcePermission('read', 'permissions'), baseCtx())
    expect(sql).not.toMatch(/\bapp\./)
  })

  it('honors an overridden compileHasResourcePermission', () => {
    const custom = compileExpr(
      hasResourcePermission('read', 'permissions'),
      baseCtx({ compileHasResourcePermission: () => 'CUSTOM' })
    )
    expect(custom).toBe('CUSTOM')
  })
})

describe('compileExpr — default-compiler helpers compose with predicates', () => {
  it('defaultCompileHasAppRole / defaultCompileHasGrant fragments embed the role/action name', () => {
    const ctx = baseCtx({ qualifyColumns: true })
    expect(defaultCompileHasAppRole('a', ctx)).toContain("? 'a'")
    expect(defaultCompileHasGrant('edit', 'workbench.id', ctx)).toContain("-> 'edit'")
  })
})

describe('compileExpr — isOwner (default strategy)', () => {
  it('compiles isOwner as col = (sub claim)::uuid', () => {
    expect(compileExpr(isOwner('owner_id'), baseCtx())).toBe(
      "(owner_id = (current_setting('request.jwt.claims', true)::json ->> 'sub')::uuid)"
    )
  })

  it('honors an overridden compileIsOwner', () => {
    expect(compileExpr(isOwner('owner_id'), baseCtx({ compileIsOwner: () => 'CUSTOM_OWNER' }))).toBe('CUSTOM_OWNER')
  })

  it('default helpers compose with predicates', () => {
    const ctx = baseCtx({ qualifyColumns: true })
    expect(defaultCompileIsOwner('workbench.owner_id', ctx)).toContain('workbench.owner_id =')
  })
})

describe('compileExpr — inArray', () => {
  it('uses jsonb ? operator with text cast on needle', () => {
    expect(compileExpr(inArray(col('workspace_id'), claim('workspaceIds')), baseCtx())).toBe(
      "((current_setting('request.jwt.claims', true)::jsonb -> 'workspaceIds') ? (workspace_id)::text)"
    )
  })
})

describe('compileExpr — raw', () => {
  it('wraps the raw SQL in parens', () => {
    expect(compileExpr(raw('tenant_id IS NOT NULL'), baseCtx())).toBe('(tenant_id IS NOT NULL)')
  })
})

describe('compileExpr — hasGrant with source: "table"', () => {
  // Uses the top-level `hasGrant` factory defined at the top of this file.

  // Both grant-table columns and the outer scope reference are fully
  // qualified — the grant table's name on the inner side; the policy's
  // `ctx.table` ('workbench' in the baseCtx) on the outer side. Without
  // this, an unqualified `"workspaceId" = "workspaceId"` inside the
  // subquery would bind both sides to the inner table and degenerate to
  // "any grant row exists" — losing the outer-row correlation.
  // quoteIdent leaves snake_case identifiers bare and only quotes
  // camelCase / reserved names.
  it('compiles a per-resource table with actionsColumn (text[] via ANY)', () => {
    const ctx = baseCtx({
      resourceGrants: defineResourceGrants({
        source: 'table',
        actions: ['edit'] as const,
        tables: {
          workspaceId: { name: 'workspace_grant', principalColumn: 'userId', actionsColumn: 'actions' },
        },
      }),
    })
    expect(compileExpr(hasGrant('edit', 'workspaceId'), ctx)).toBe(
      `EXISTS (SELECT 1 FROM workspace_grant WHERE workspace_grant."userId" = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid AND workspace_grant."workspaceId" = workbench."workspaceId" AND 'edit' = ANY(workspace_grant.actions))`
    )
  })

  it('compiles a per-resource table with actionColumn (one row per action)', () => {
    const ctx = baseCtx({
      resourceGrants: defineResourceGrants({
        source: 'table',
        actions: ['edit'] as const,
        tables: {
          workspaceId: { name: 'workspace_grant', principalColumn: 'userId', actionColumn: 'action' },
        },
      }),
    })
    expect(compileExpr(hasGrant('edit', 'workspaceId'), ctx)).toBe(
      `EXISTS (SELECT 1 FROM workspace_grant WHERE workspace_grant."userId" = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid AND workspace_grant."workspaceId" = workbench."workspaceId" AND workspace_grant.action = 'edit')`
    )
  })

  it('honors a custom resourceIdColumn on a per-resource entry', () => {
    const ctx = baseCtx({
      resourceGrants: defineResourceGrants({
        source: 'table',
        actions: ['edit'] as const,
        tables: {
          workspaceId: {
            name: 'workspace_grant',
            principalColumn: 'userId',
            resourceIdColumn: 'ws_id',
            actionsColumn: 'actions',
          },
        },
      }),
    })
    expect(compileExpr(hasGrant('edit', 'workspaceId'), ctx)).toBe(
      `EXISTS (SELECT 1 FROM workspace_grant WHERE workspace_grant."userId" = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid AND workspace_grant.ws_id = workbench."workspaceId" AND 'edit' = ANY(workspace_grant.actions))`
    )
  })

  it('falls back to the polymorphic table when no per-resource entry matches', () => {
    const ctx = baseCtx({
      resourceGrants: defineResourceGrants({
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
      }),
    })
    // workspaceId hits the per-resource override:
    expect(compileExpr(hasGrant('edit', 'workspaceId'), ctx)).toContain('FROM workspace_grant')
    // tenantId falls through to the polymorphic table:
    expect(compileExpr(hasGrant('edit', 'tenantId'), ctx)).toBe(
      `EXISTS (SELECT 1 FROM resource_grant WHERE resource_grant."userId" = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid AND resource_grant."resourceId" = workbench."tenantId" AND resource_grant."resourceType" = 'Tenant' AND 'edit' = ANY(resource_grant.actions))`
    )
  })

  it('honors a custom principalClaim', () => {
    const ctx = baseCtx({
      resourceGrants: defineResourceGrants({
        source: 'table',
        actions: ['edit'] as const,
        principalClaim: 'userId',
        tables: {
          workspaceId: { name: 'workspace_grant', principalColumn: 'userId', actionsColumn: 'actions' },
        },
      }),
    })
    expect(compileExpr(hasGrant('edit', 'workspaceId'), ctx)).toContain(
      `"userId" = (current_setting('request.jwt.claims', true)::jsonb ->> 'userId')::uuid`
    )
  })

  it('throws at compile time when no per-resource entry and no fallback exists for the scope column', () => {
    const ctx = baseCtx({
      resourceGrants: defineResourceGrants({
        source: 'table',
        actions: ['edit'] as const,
        tables: {
          workspaceId: { name: 'workspace_grant', principalColumn: 'userId', actionsColumn: 'actions' },
        },
      }),
    })
    expect(() => compileExpr(hasGrant('edit', 'unknownColumn'), ctx)).toThrow(
      /no per-resource entry in tables\{\} and no fallbackTable configured/
    )
  })

  it('throws when polymorphic fallback has no scopeColumnTypeMap entry for the column', () => {
    const ctx = baseCtx({
      resourceGrants: defineResourceGrants({
        source: 'table',
        actions: ['edit'] as const,
        fallbackTable: {
          name: 'resource_grant',
          principalColumn: 'userId',
          resourceTypeColumn: 'resourceType',
          resourceIdColumn: 'resourceId',
          actionsColumn: 'actions',
          scopeColumnTypeMap: { tenantId: 'Tenant' }, // does NOT cover workspaceId
        },
      }),
    })
    expect(() => compileExpr(hasGrant('edit', 'workspaceId'), ctx)).toThrow(
      /scopeColumnTypeMap has no entry for "workspaceId"/
    )
  })

  it('explicit compileHasGrant override still wins over source-based dispatch', () => {
    const ctx = baseCtx({
      resourceGrants: defineResourceGrants({
        source: 'table',
        actions: ['edit'] as const,
        tables: {
          workspaceId: { name: 'workspace_grant', principalColumn: 'userId', actionsColumn: 'actions' },
        },
      }),
      compileHasGrant: () => '/* override */',
    })
    expect(compileExpr(hasGrant('edit', 'workspaceId'), ctx)).toBe('/* override */')
  })

  // Rank-based grants (issue #5). baseCtx table is 'workbench'.
  it('rank-based: emits the qualifying-suffix array with an enum cast', () => {
    const ctx = baseCtx({
      resourceGrants: defineResourceGrants({
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
      }),
    })
    // hasGrant('EDITOR', ...) → EDITOR and every higher rank.
    expect(compileExpr(hasGrant('EDITOR', 'workspaceId'), ctx)).toBe(
      `EXISTS (SELECT 1 FROM workspace_grants WHERE workspace_grants.user_id = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid AND workspace_grants."workspaceId" = workbench."workspaceId" AND workspace_grants.role = ANY(ARRAY['EDITOR', 'MANAGER', 'OWNER']::"ResourceRole"[]))`
    )
  })

  it('rank-based: highest rank yields a single-element array; no cast when roleColumnType omitted', () => {
    const ctx = baseCtx({
      resourceGrants: defineResourceGrants({
        source: 'table',
        actions: ['READER', 'EDITOR', 'OWNER'] as const,
        tables: {
          workspaceId: {
            name: 'workspace_grants',
            principalColumn: 'user_id',
            roleColumn: 'role',
            roleHierarchy: ['READER', 'EDITOR', 'OWNER'],
          },
        },
      }),
    })
    expect(compileExpr(hasGrant('OWNER', 'workspaceId'), ctx)).toContain(`workspace_grants.role = ANY(ARRAY['OWNER'])`)
  })

  // Principal disjunction (issue #6).
  it('principal disjunction: emits (user = ref OR group IN member-lookup)', () => {
    const ctx = baseCtx({
      resourceGrants: defineResourceGrants({
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
        principalClaim: 'user_id',
      }),
    })
    expect(compileExpr(hasGrant('edit', 'workspaceId'), ctx)).toBe(
      `EXISTS (SELECT 1 FROM workspace_grants WHERE (workspace_grants.user_id = (current_setting('request.jwt.claims', true)::jsonb ->> 'user_id')::uuid OR workspace_grants.group_id IN (SELECT org_group_members.group_id FROM org_group_members WHERE org_group_members.user_id = (current_setting('request.jwt.claims', true)::jsonb ->> 'user_id')::uuid)) AND workspace_grants."workspaceId" = workbench."workspaceId" AND 'edit' = ANY(workspace_grants.actions))`
    )
  })

  // Per-call table hint (issue #11 / ADR-0025). baseCtx table is 'workbench'.
  const hasGrantHinted = (action: string, scopeColumn: string, table: string): Expr =>
    Object.freeze({ kind: 'hasGrant', action, scopeColumn, tableHint: table }) as Expr

  it('table hint routes col("id") to the hinted entry, not the scope-column key', () => {
    // Two grant tables registered under workspaceId / workbenchId. A policy
    // checking the resource's OWN id ('id') routes via the hint.
    const rg = defineResourceGrants({
      source: 'table',
      actions: ['READER'] as const,
      tables: {
        workspaceId: { name: 'workspace_grants', principalColumn: 'user_id', actionsColumn: 'actions' },
        workbenchId: { name: 'workbench_grants', principalColumn: 'user_id', actionsColumn: 'actions' },
      },
    })
    const ctx = baseCtx({ table: 'workspaces', resourceGrants: rg })
    // hasGrant('READER', col('id'), { table: 'workspaceId' }) — resourceId
    // default comes from the registration key (workspaceId); outer ref is
    // the call's own 'id' qualified with the policy table (workspaces).
    expect(compileExpr(hasGrantHinted('READER', 'id', 'workspaceId'), ctx)).toBe(
      `EXISTS (SELECT 1 FROM workspace_grants WHERE workspace_grants.user_id = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid AND workspace_grants."workspaceId" = workspaces.id AND 'READER' = ANY(workspace_grants.actions))`
    )
  })

  it('two policies both checking col("id") route to different tables via hints', () => {
    const rg = defineResourceGrants({
      source: 'table',
      actions: ['READER'] as const,
      tables: {
        workspaceId: { name: 'workspace_grants', principalColumn: 'user_id', actionsColumn: 'actions' },
        workbenchId: { name: 'workbench_grants', principalColumn: 'user_id', actionsColumn: 'actions' },
      },
    })
    const wsCtx = baseCtx({ table: 'workspaces', resourceGrants: rg })
    const wbCtx = baseCtx({ table: 'workbenches', resourceGrants: rg })
    expect(compileExpr(hasGrantHinted('READER', 'id', 'workspaceId'), wsCtx)).toContain('FROM workspace_grants')
    expect(compileExpr(hasGrantHinted('READER', 'id', 'workbenchId'), wbCtx)).toContain('FROM workbench_grants')
  })

  it('unknown table hint throws with the declared keys', () => {
    const ctx = baseCtx({
      resourceGrants: defineResourceGrants({
        source: 'table',
        actions: ['READER'] as const,
        tables: { workspaceId: { name: 'workspace_grants', principalColumn: 'user_id', actionsColumn: 'actions' } },
      }),
    })
    expect(() => compileExpr(hasGrantHinted('READER', 'id', 'nope'), ctx)).toThrow(
      /no tables\["nope"\] entry\. Declared keys: \[workspaceId\]/
    )
  })

  it('rank + disjunction compose in one table config', () => {
    const ctx = baseCtx({
      resourceGrants: defineResourceGrants({
        source: 'table',
        actions: ['READER', 'EDITOR', 'OWNER'] as const,
        tables: {
          workspaceId: {
            name: 'workspace_grants',
            principalUserColumn: 'user_id',
            principalGroupColumn: 'group_id',
            groupMemberTable: { name: 'org_group_members', userColumn: 'user_id', groupColumn: 'group_id' },
            roleColumn: 'role',
            roleHierarchy: ['READER', 'EDITOR', 'OWNER'],
          },
        },
      }),
    })
    const sql = compileExpr(hasGrant('EDITOR', 'workspaceId'), ctx)
    expect(sql).toContain('workspace_grants.group_id IN (SELECT org_group_members.group_id')
    expect(sql).toContain(`workspace_grants.role = ANY(ARRAY['EDITOR', 'OWNER'])`)
  })
})
