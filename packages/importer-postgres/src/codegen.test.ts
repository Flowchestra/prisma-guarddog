import { describe, expect, it } from 'vitest'

import { generateScaffold } from './codegen.js'
import type { ImportedColumnPrivilege, ImportedPolicyRow } from './db.js'

function policy(partial: Partial<ImportedPolicyRow>): ImportedPolicyRow {
  return Object.freeze({
    schema: 'public',
    table: 'workbench',
    policyName: 'p',
    command: 'SELECT',
    roles: Object.freeze(['app_user']),
    usingExpression: 'true',
    withCheckExpression: null,
    permissive: true,
    ...partial,
  }) as ImportedPolicyRow
}

function colPriv(partial: Partial<ImportedColumnPrivilege>): ImportedColumnPrivilege {
  return Object.freeze({
    schema: 'public',
    table: 'workbench',
    column: 'apiKey',
    grantee: 'app_system',
    privilege: 'SELECT',
    ...partial,
  }) as ImportedColumnPrivilege
}

describe('generateScaffold()', () => {
  it('includes the banner and an exported function declaration', () => {
    const out = generateScaffold({ policies: [], columnPrivileges: [] })
    expect(out).toContain('Auto-generated')
    expect(out).toContain('export function importedPolicies(guard: Guarddog): void {')
  })

  it('emits a noop body when nothing was imported', () => {
    const out = generateScaffold({ policies: [], columnPrivileges: [] })
    expect(out).toContain('No existing pg_policies rows were imported.')
  })

  it('renders one rawSql() + .todo() per (model, role, verb)', () => {
    const out = generateScaffold({
      policies: [
        policy({
          table: 'workbench',
          policyName: 'workbench_app_user_select',
          command: 'SELECT',
          roles: ['app_user'],
          usingExpression: "tenant_id = current_setting('x')::uuid",
        }),
      ],
      columnPrivileges: [],
      modelMap: { workbench: 'Workbench' },
    })
    expect(out).toContain(`guard.model('Workbench').policy('app_user')`)
    expect(out).toContain(`.rawSql('select', "tenant_id = current_setting('x')::uuid")`)
    expect(out).toContain(
      `.todo("replace raw SQL with typed predicate — imported from pg_policies \\"workbench_app_user_select\\"")`
    )
  })

  it('expands cmd=ALL into all four verbs', () => {
    const out = generateScaffold({
      policies: [
        policy({
          policyName: 'p_all',
          command: 'ALL',
          usingExpression: 'true',
          withCheckExpression: 'true',
        }),
      ],
      columnPrivileges: [],
      modelMap: { workbench: 'Workbench' },
    })
    expect(out).toContain(".rawSql('select'")
    expect(out).toContain(".rawSql('insert'")
    expect(out).toContain(".rawSql('update'")
    expect(out).toContain(".rawSql('delete'")
  })

  it('flags inferred model names with a TODO when no modelMap entry exists', () => {
    const out = generateScaffold({
      policies: [policy({ table: 'scope_target', policyName: 'p1' })],
      columnPrivileges: [],
    })
    expect(out).toContain(`// TODO: confirm model name "ScopeTarget" — inferred from table heuristically.`)
    expect(out).toContain(`guard.model('ScopeTarget').policy('app_user')`)
  })

  it('groups column privileges per table and joins SELECT/INSERT/UPDATE arrays', () => {
    const out = generateScaffold({
      policies: [],
      columnPrivileges: [
        colPriv({ column: 'apiKey', grantee: 'app_system', privilege: 'SELECT' }),
        colPriv({ column: 'apiKey', grantee: 'app_system', privilege: 'UPDATE' }),
        colPriv({ column: 'notes', grantee: 'app_admin', privilege: 'SELECT' }),
      ],
      modelMap: { workbench: 'Workbench' },
    })
    expect(out).toContain(`guard.model('Workbench').columnPrivileges({`)
    expect(out).toMatch(/apiKey:\s*\{ select: \['app_system'\], update: \['app_system'\] \}/)
    expect(out).toMatch(/notes:\s*\{ select: \['app_admin'\] \}/)
  })

  it('uses INSERT WITH CHECK expression for the insert rawSql, USING for everything else', () => {
    const out = generateScaffold({
      policies: [
        policy({
          policyName: 'p_insert',
          command: 'INSERT',
          usingExpression: null,
          withCheckExpression: 'tenant_id IS NOT NULL',
        }),
      ],
      columnPrivileges: [],
      modelMap: { workbench: 'Workbench' },
    })
    expect(out).toContain(`.rawSql('insert', "tenant_id IS NOT NULL")`)
  })
})
