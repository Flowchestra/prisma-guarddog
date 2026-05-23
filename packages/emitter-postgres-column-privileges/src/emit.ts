/**
 * Compile a `ColumnPrivilegeAst` into Postgres column-level GRANT statements.
 *
 * Per ADR-0004, this emitter handles ONLY static role-based column
 * privileges. Row-conditional masking (`.masks()` / `.projection()`) is
 * Phase 2 and lives in a separate emitter package.
 *
 * GRANT is natively idempotent — re-running the same GRANT against the
 * same (column, role) is a no-op (or emits a NOTICE) in Postgres. No
 * DROP/CREATE pair needed.
 *
 * The column grants only become meaningful when base-table privileges are
 * restricted (otherwise PUBLIC default privileges override per-column
 * rules). The CLI-level orchestrator will emit table-level REVOKE
 * statements as a separate prelude; this emitter focuses on the GRANTs
 * themselves.
 */

import type { ColumnPrivilegeAst, ColumnPrivilegeGrant } from '@prisma-guarddog/core'

import { quoteIdent, resolveTableName } from './identifiers.js'

export interface EmitContext {
  /**
   * Override the Prisma model -> table name mapping. Falls back to a
   * default CamelCase -> snake_case resolver. Consumers with @@map()
   * directives should plug in a DMMF-bridged resolver (see
   * `@prisma-guarddog/importer-prisma`'s `ModelTables`).
   */
  readonly resolveTable?: (modelName: string) => string
}

type Verb = 'SELECT' | 'INSERT' | 'UPDATE'

/**
 * Compile a single `ColumnPrivilegeAst` to a flat array of `GRANT` statements.
 * Each (column, verb, role-list) triple produces one `GRANT <VERB>(<col>)
 * ON <table> TO <roles>;` statement. Verb / column order is deterministic
 * (verbs in SELECT/INSERT/UPDATE order; columns in declaration order from
 * the AST) so diffs across runs stay stable.
 */
export function emitColumnPrivileges(ast: ColumnPrivilegeAst, ctx: EmitContext = {}): readonly string[] {
  const table = resolveTableName(ast.model, ast.table, ctx.resolveTable)
  const quotedTable = quoteIdent(table)
  const out: string[] = []

  for (const [columnName, grants] of Object.entries(ast.columns)) {
    appendIfGranted(out, 'SELECT', columnName, quotedTable, grants.select)
    appendIfGranted(out, 'INSERT', columnName, quotedTable, grants.insert)
    appendIfGranted(out, 'UPDATE', columnName, quotedTable, grants.update)
  }

  return Object.freeze(out)
}

function appendIfGranted(
  out: string[],
  verb: Verb,
  columnName: string,
  quotedTable: string,
  roles: ColumnPrivilegeGrant[keyof ColumnPrivilegeGrant]
): void {
  if (roles.length === 0) return
  const quotedRoles = roles.map(quoteIdent).join(', ')
  out.push(`GRANT ${verb}(${quoteIdent(columnName)}) ON ${quotedTable} TO ${quotedRoles};`)
}
