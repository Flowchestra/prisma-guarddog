/**
 * Render imported Postgres state as a TypeScript scaffold file the user
 * can copy/paste into their `prisma/guarddog.ts` `policies(guard)`
 * callback.
 *
 * The scaffold uses `rawSql()` for every imported policy and tags each
 * with a `.todo()` marker pointing at the source `pg_policies.policyname`.
 * The user reviews, replaces raw SQL with typed predicates, and removes
 * the todos as they go. ADR-0012.
 *
 * Pure — no I/O. Tests assert exact string output for a handful of
 * representative shapes.
 */

import type { ImportedColumnPrivilege, ImportedPolicyRow } from './db.js'

export interface GenerateScaffoldInput {
  readonly policies: ReadonlyArray<ImportedPolicyRow>
  readonly columnPrivileges: ReadonlyArray<ImportedColumnPrivilege>
  /**
   * Optional table-name → Prisma model-name map. Tables not in the map
   * fall through to a heuristic PascalCase transform; the rendered scaffold
   * flags those with a TODO so the user can fix the model reference.
   */
  readonly modelMap?: Readonly<Record<string, string>>
  /**
   * Banner placed at the top of the generated file. Defaults to a generic
   * description; consumers can override with engagement/run metadata.
   */
  readonly banner?: string
}

/**
 * Produce a complete `.ts` source string. The output is suitable for
 * `writeFile('scaffold.generated.ts', source)`.
 */
export function generateScaffold(input: GenerateScaffoldInput): string {
  const banner = input.banner ?? defaultBanner()
  const lines: string[] = []
  lines.push(banner, '', `import type { Guarddog } from '@flowchestra/prisma-guarddog'`, '')
  lines.push('/** Drop this into your guarddog.ts `policies(guard)` callback. */')
  lines.push('export function importedPolicies(guard: Guarddog): void {')
  appendPolicyBlocks(lines, input.policies, input.modelMap)
  appendColumnPrivilegeBlocks(lines, input.columnPrivileges, input.modelMap)
  lines.push('}', '')
  return lines.join('\n')
}

function appendPolicyBlocks(
  lines: string[],
  policies: ReadonlyArray<ImportedPolicyRow>,
  modelMap: Readonly<Record<string, string>> | undefined
): void {
  if (policies.length === 0) {
    lines.push('  // No existing pg_policies rows were imported.')
    return
  }
  const byKey = groupPoliciesByModelAndRole(policies, modelMap)
  for (const [key, entries] of byKey) {
    const { modelName, dbRole, modelInferred } = key
    lines.push('')
    if (modelInferred) {
      lines.push(`  // TODO: confirm model name "${modelName}" — inferred from table heuristically.`)
    }
    const chain: string[] = [`  guard.model('${modelName}').policy('${dbRole}')`]
    for (const entry of entries) {
      chain.push(`    .${entry.builder}`)
      chain.push(`    .todo(${JSON.stringify(entry.todo)})`)
    }
    lines.push(chain.join('\n'))
  }
}

function appendColumnPrivilegeBlocks(
  lines: string[],
  grants: ReadonlyArray<ImportedColumnPrivilege>,
  modelMap: Readonly<Record<string, string>> | undefined
): void {
  if (grants.length === 0) return
  lines.push('')
  const byTable = new Map<string, ImportedColumnPrivilege[]>()
  for (const g of grants) {
    const list = byTable.get(g.table) ?? []
    list.push(g)
    byTable.set(g.table, list)
  }
  for (const [table, entries] of [...byTable].toSorted(([a], [b]) => a.localeCompare(b))) {
    const { modelName, inferred } = resolveModel(table, modelMap)
    if (inferred) {
      lines.push(`  // TODO: confirm model name "${modelName}" — inferred from table heuristically.`)
    }
    lines.push(`  guard.model('${modelName}').columnPrivileges({`)
    const columns = groupByColumn(entries)
    for (const [column, columnGrants] of [...columns].toSorted(([a], [b]) => a.localeCompare(b))) {
      const verbs: string[] = []
      const sel = uniqueSorted(columnGrants.filter((g) => g.privilege === 'SELECT').map((g) => g.grantee))
      const ins = uniqueSorted(columnGrants.filter((g) => g.privilege === 'INSERT').map((g) => g.grantee))
      const upd = uniqueSorted(columnGrants.filter((g) => g.privilege === 'UPDATE').map((g) => g.grantee))
      if (sel.length > 0) verbs.push(`select: [${sel.map((r) => `'${r}'`).join(', ')}]`)
      if (ins.length > 0) verbs.push(`insert: [${ins.map((r) => `'${r}'`).join(', ')}]`)
      if (upd.length > 0) verbs.push(`update: [${upd.map((r) => `'${r}'`).join(', ')}]`)
      lines.push(`    ${quoteKey(column)}: { ${verbs.join(', ')} },`)
    }
    lines.push('  })')
  }
}

interface PolicyEntry {
  readonly builder: string
  readonly todo: string
}

interface GroupKey {
  readonly modelName: string
  readonly dbRole: string
  readonly modelInferred: boolean
}

function groupPoliciesByModelAndRole(
  policies: ReadonlyArray<ImportedPolicyRow>,
  modelMap: Readonly<Record<string, string>> | undefined
): Map<GroupKey, PolicyEntry[]> {
  // Stable iteration: sort the input deterministically before grouping.
  const sorted = [...policies].toSorted((a, b) => {
    const t = a.table.localeCompare(b.table)
    if (t !== 0) return t
    return a.policyName.localeCompare(b.policyName)
  })

  // We can't key a Map on object identity for grouping; use a string sub-key
  // and remember the GroupKey object separately so iteration preserves order.
  const order: GroupKey[] = []
  const seen = new Map<string, GroupKey>()
  const buckets = new Map<string, PolicyEntry[]>()

  for (const row of sorted) {
    const { modelName, inferred } = resolveModel(row.table, modelMap)
    for (const role of row.roles) {
      const subKey = `${modelName}::${role}`
      let groupKey = seen.get(subKey)
      if (groupKey === undefined) {
        groupKey = Object.freeze({ modelName, dbRole: role, modelInferred: inferred })
        seen.set(subKey, groupKey)
        order.push(groupKey)
        buckets.set(subKey, [])
      }
      const verbList = expandCommand(row.command)
      for (const verb of verbList) {
        buckets.get(subKey)!.push(makePolicyEntry(verb, row))
      }
    }
  }

  const out = new Map<GroupKey, PolicyEntry[]>()
  for (const key of order) {
    out.set(key, buckets.get(`${key.modelName}::${key.dbRole}`) ?? [])
  }
  return out
}

function makePolicyEntry(verb: 'select' | 'insert' | 'update' | 'delete', row: ImportedPolicyRow): PolicyEntry {
  const sql = verb === 'insert' ? (row.withCheckExpression ?? 'true') : (row.usingExpression ?? 'true')
  return Object.freeze({
    builder: `rawSql('${verb}', ${JSON.stringify(sql)})`,
    todo: `replace raw SQL with typed predicate — imported from pg_policies "${row.policyName}"`,
  })
}

function expandCommand(cmd: ImportedPolicyRow['command']): ReadonlyArray<'select' | 'insert' | 'update' | 'delete'> {
  if (cmd === 'ALL') return ['select', 'insert', 'update', 'delete'] as const
  return [cmd.toLowerCase() as 'select' | 'insert' | 'update' | 'delete']
}

function groupByColumn(grants: ReadonlyArray<ImportedColumnPrivilege>): Map<string, ImportedColumnPrivilege[]> {
  const out = new Map<string, ImportedColumnPrivilege[]>()
  for (const g of grants) {
    const list = out.get(g.column) ?? []
    list.push(g)
    out.set(g.column, list)
  }
  return out
}

function uniqueSorted(xs: ReadonlyArray<string>): string[] {
  return [...new Set(xs)].toSorted()
}

/**
 * Resolve a Postgres table name to a Prisma model name. Explicit map wins;
 * otherwise apply a snake_case → PascalCase heuristic and flag the result
 * as inferred so the scaffold caller can emit a TODO marker.
 */
function resolveModel(
  table: string,
  modelMap: Readonly<Record<string, string>> | undefined
): { readonly modelName: string; readonly inferred: boolean } {
  const explicit = modelMap?.[table]
  if (explicit !== undefined) return { modelName: explicit, inferred: false }
  return { modelName: snakeToPascal(table), inferred: true }
}

function snakeToPascal(s: string): string {
  return s
    .split('_')
    .filter((p) => p.length > 0)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join('')
}

function quoteKey(name: string): string {
  // Bare key when safe-identifier; quoted otherwise.
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name)
}

function defaultBanner(): string {
  return [
    '// Auto-generated by `@flowchestra/prisma-guarddog-importer-postgres`.',
    '// Review each rawSql() and replace with a typed predicate; remove .todo() as you go.',
    '// Re-run the importer to refresh; the generated file is not meant to be hand-edited.',
  ].join('\n')
}
