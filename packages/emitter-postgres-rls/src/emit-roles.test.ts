import { defineDbRoles } from '@flowchestra/prisma-guarddog-core'
import { describe, expect, it } from 'vitest'

import { emitRoles } from './emit-roles.js'

describe('emitRoles — CREATE ROLE pass', () => {
  it('emits an idempotent CREATE ROLE block for each declared role', () => {
    const sql = emitRoles(
      defineDbRoles({
        app_user: { inherits: [] },
        app_system: { inherits: ['app_user'], bypassesRls: true },
      })
    )
    expect(sql).toHaveLength(3) // 2 CREATE + 1 GRANT
    expect(sql[0]).toContain("pg_roles WHERE rolname = 'app_user'")
    expect(sql[0]).toContain('CREATE ROLE app_user INHERIT;')
    expect(sql[1]).toContain("pg_roles WHERE rolname = 'app_system'")
    expect(sql[1]).toContain('CREATE ROLE app_system INHERIT BYPASSRLS;')
  })

  it('honors the nologin flag', () => {
    const sql = emitRoles(defineDbRoles({ background_worker: { inherits: [], nologin: true } }))
    expect(sql[0]).toContain('CREATE ROLE background_worker INHERIT NOLOGIN;')
  })

  it('emits INHERIT explicitly (overrides Postgres NOINHERIT default in pg16+)', () => {
    const sql = emitRoles(defineDbRoles({ r: { inherits: [] } }))
    expect(sql[0]).toContain('CREATE ROLE r INHERIT;')
  })

  it('wraps each CREATE in a DO block that checks pg_roles first', () => {
    const sql = emitRoles(defineDbRoles({ r: { inherits: [] } }))
    expect(sql[0]).toMatch(/^DO \$\$/)
    expect(sql[0]).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_roles/)
    expect(sql[0]).toMatch(/\$\$;$/)
  })
})

describe('emitRoles — GRANT membership pass', () => {
  it('emits one GRANT per inherits entry', () => {
    const sql = emitRoles(
      defineDbRoles({
        app_user: { inherits: [] },
        app_system: { inherits: ['app_user'] },
        app_admin: { inherits: ['app_system'] },
      })
    )
    const grants = sql.filter((s) => s.includes('GRANT '))
    expect(grants).toHaveLength(2)
    expect(grants[0]).toContain('GRANT app_user TO app_system;')
    expect(grants[1]).toContain('GRANT app_system TO app_admin;')
  })

  it('wraps each GRANT in a DO block that checks pg_auth_members first', () => {
    const sql = emitRoles(
      defineDbRoles({
        a: { inherits: [] },
        b: { inherits: ['a'] },
      })
    )
    const grantStmt = sql.find((s) => s.includes('GRANT a TO b'))!
    expect(grantStmt).toMatch(/^DO \$\$/)
    expect(grantStmt).toMatch(/IF NOT EXISTS \(/)
    expect(grantStmt).toContain('pg_auth_members')
    expect(grantStmt).toContain("parent.rolname = 'a' AND child.rolname = 'b'")
  })

  it('emits CREATE ROLE pass before GRANT pass — forward references in inherits are fine', () => {
    const sql = emitRoles(
      defineDbRoles({
        // Order intentionally not topological — declared child first.
        app_system: { inherits: ['app_user'] },
        app_user: { inherits: [] },
      })
    )
    // Both CREATEs come before the GRANT regardless of declaration order.
    const createCount = sql.filter((s) => s.includes('CREATE ROLE ')).length
    const grantIdx = sql.findIndex((s) => s.includes('GRANT '))
    expect(createCount).toBe(2)
    expect(grantIdx).toBe(2)
    expect(sql.slice(0, 2).every((s) => s.includes('CREATE ROLE '))).toBe(true)
  })
})

describe('emitRoles — output stability', () => {
  it('returns a frozen array', () => {
    const sql = emitRoles(defineDbRoles({ r: { inherits: [] } }))
    expect(Object.isFrozen(sql)).toBe(true)
  })

  it('produces no output for an empty role set', () => {
    const sql = emitRoles(defineDbRoles({}))
    expect(sql).toEqual([])
  })

  it('output is purely declarative — no consumer-side helpers referenced', () => {
    const sql = emitRoles(
      defineDbRoles({
        app_user: { inherits: [] },
        app_system: { inherits: ['app_user'], bypassesRls: true, nologin: true },
      })
    ).join('\n')
    expect(sql).not.toContain('app.')
    expect(sql).not.toContain('app_schema')
    // Only Postgres built-ins should appear.
    expect(sql).toContain('pg_roles')
    expect(sql).toContain('pg_auth_members')
  })
})
