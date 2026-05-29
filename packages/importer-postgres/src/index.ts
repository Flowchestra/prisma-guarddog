/**
 * `@flowchestra/prisma-guarddog-importer-postgres` — pg_policies + column-privileges importer.
 *
 * Two-layer surface:
 *   - `readPgPolicies` / `readColumnPrivileges` — pure adapters that take a
 *     pg-compatible client and return normalized rows.
 *   - `generateScaffold` — pure codegen that turns those rows into a
 *     TypeScript module the user can fold into their guarddog.ts.
 *
 * Scaffold-only — SQL is evidence, not gospel. Imported policies are
 * always emitted as `rawSql()` + `.todo()` so the user can review and
 * replace with typed predicates incrementally. See ADR-0012.
 */

export { readColumnPrivileges, readPgPolicies, readPolicyInventory } from './db.js'
export type {
  ImportedColumnPrivilege,
  ImportedPolicyRow,
  PgQueryClient,
  PolicyInventoryRow,
  ReadPoliciesOptions,
} from './db.js'

export { generateScaffold } from './codegen.js'
export type { GenerateScaffoldInput } from './codegen.js'
