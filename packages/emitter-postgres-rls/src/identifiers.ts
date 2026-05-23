/**
 * Postgres identifier quoting, literal escaping, and naming conventions.
 * Pure functions. No I/O.
 */

import type { LiteralValue } from '@prisma-guarddog/core'

/**
 * Quote a Postgres identifier (table name, column name, role name, policy
 * name). Identifiers that match the safe-unquoted pattern (lowercase
 * letters, digits, underscore, starting with a letter or underscore) are
 * returned bare; everything else is double-quoted with internal quotes
 * doubled.
 *
 * Reserved words are NOT detected here — Postgres' parser will accept them
 * unquoted in many contexts but the safest move is for callers to quote
 * explicitly when they know they're using a reserved name. The conservative
 * default this function applies is sufficient for guarddog-generated names.
 */
export function quoteIdent(name: string): string {
  if (name.length === 0) {
    throw new Error('[prisma-guarddog/emitter-postgres-rls] quoteIdent: identifier must be non-empty.')
  }
  if (/^[a-z_][a-z0-9_]*$/.test(name)) return name
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * Escape and quote a SQL string literal. Doubles internal single quotes.
 */
export function quoteString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/**
 * Format a `LiteralValue` as a Postgres literal expression.
 */
export function formatLiteral(value: LiteralValue): string {
  if (value === null) return 'NULL'
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(
        `[prisma-guarddog/emitter-postgres-rls] formatLiteral: non-finite number is not a valid SQL literal: ${String(value)}`
      )
    }
    return String(value)
  }
  return quoteString(value)
}

/**
 * Default Prisma-model -> table-name resolver. Converts CamelCase to
 * snake_case and lowercases. Does NOT pluralize — Prisma's default with no
 * `@@map` directive produces a singular lowercased name (e.g., model
 * `Workbench` -> table `workbench`). Consumers using `@@map` or non-default
 * naming should override via the emit context.
 *
 *   defaultTableResolver('Workbench')   // 'workbench'
 *   defaultTableResolver('ScopeTarget') // 'scope_target'
 *   defaultTableResolver('APIKey')      // 'api_key'
 */
export function defaultTableResolver(modelName: string): string {
  return modelName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
}

/**
 * Convention for emitted policy names. Stable, deterministic, diffable:
 *
 *   <table>_<dbRole>_<verb>                            -- regular
 *   <table>_<discriminator_value>_<dbRole>_<verb>      -- polymorphic
 *
 * All segments are snake_cased (the discriminator value gets the same
 * treatment as `defaultTableResolver` applies to model names). Length is
 * bounded by Postgres' 63-byte default identifier limit; callers should
 * audit if their model + role names threaten that.
 */
export function policyName(parts: {
  table: string
  dbRole: string
  verb: string
  discriminatorValue?: string
}): string {
  const segments = [
    parts.table,
    ...(parts.discriminatorValue !== undefined ? [snakeCase(parts.discriminatorValue)] : []),
    parts.dbRole,
    parts.verb,
  ]
  return segments.join('_').toLowerCase()
}

function snakeCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
}
