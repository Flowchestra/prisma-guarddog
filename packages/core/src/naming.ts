/**
 * Naming conventions for guarddog-emitted Postgres objects.
 *
 * These live in core (rather than each emitter package) because the
 * naming convention is a guarddog standard — the same `<table>_<dbRole>_<verb>`
 * policy name is used by every emitter and by the diff/replay machinery
 * that has to recognize a policy across migration boundaries.
 *
 * Postgres-specific quoting / literal formatting stays in each emitter
 * (those ARE dialect-specific).
 */

import type { Verb } from './ast.js'

/**
 * Convert CamelCase / PascalCase to snake_case. Used by the default
 * Prisma-model -> table-name resolver and as the input normalizer for
 * `policyName`.
 *
 *   snakeCase('Workbench')        // 'workbench'
 *   snakeCase('ScopeTarget')      // 'scope_target'
 *   snakeCase('APIKey')           // 'api_key'
 *   snakeCase('HTTPSConnection')  // 'https_connection'
 */
export function snakeCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
}

/**
 * Default Prisma-model -> table-name resolver. Lower-snake_cases the
 * model name. Matches Prisma's default behavior when no `@@map` is set.
 * Override via `EmitContext.resolveTable` (or the importer-prisma
 * `ModelTables` bridge) when `@@map` directives are in play.
 */
export function defaultTableResolver(modelName: string): string {
  return snakeCase(modelName)
}

/**
 * Compute the policy name for a (table, dbRole, verb) — and optionally a
 * polymorphic discriminator value. Convention is intentionally simple,
 * deterministic, and diff-friendly: emitted SQL across runs produces the
 * same names; renaming a model or a role IS a meaningful schema change.
 *
 *   policyName({ table: 'workbench', dbRole: 'app_user', verb: 'select' })
 *     // 'workbench_app_user_select'
 *
 *   policyName({ table: 'scope_target', dbRole: 'app_user', verb: 'select',
 *                discriminatorValue: 'Workspace' })
 *     // 'scope_target_workspace_app_user_select'
 *
 * Bounded by Postgres' 63-byte identifier limit — consumers with long
 * model + role names should audit emitted names for truncation risk.
 */
export function policyName(parts: { table: string; dbRole: string; verb: Verb; discriminatorValue?: string }): string {
  const segments = [
    parts.table,
    ...(parts.discriminatorValue !== undefined ? [snakeCase(parts.discriminatorValue)] : []),
    parts.dbRole,
    parts.verb,
  ]
  return segments.join('_').toLowerCase()
}
