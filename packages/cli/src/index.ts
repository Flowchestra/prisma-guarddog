/**
 * `prisma-guarddog` — CLI for the schema-driven policy compiler.
 *
 * Most consumers invoke the CLI via the `guarddog` / `prisma-guarddog` bin.
 * The programmatic surface exported here is for tests, scripting, and
 * editor integrations that need to reach the same routines without
 * shelling out.
 */

export { discoverConfig, findConfigFile, loadConfigFile, resolveConfig } from './config.js'
export type { GuarddogConfigFile, ResolveConfigOptions, ResolvedConfig } from './config.js'

export { loadSchema, materializeLoadedSchema, SchemaLoadError, validateSchemaModule } from './load.js'
export type { LoadedSchema } from './load.js'

export { inspectGuard, runCheck } from './commands/check.js'
export type { CheckOptions, CheckResult } from './commands/check.js'

export { planMigrate, runMigrate } from './commands/migrate.js'
export type { MigrateOptions, MigratePlan, MigrateResult } from './commands/migrate.js'

export { runEmit } from './commands/emit.js'
export type { EmitOptions, EmitResult } from './commands/emit.js'

export { runDiff } from './commands/diff.js'
export type { DiffOptions, DiffResult } from './commands/diff.js'

export { runImport } from './commands/import.js'
export type { ImportOptions, ImportResult } from './commands/import.js'

export { renderOps } from './render-ops.js'
export type { RenderContext, RenderOverrides } from './render-ops.js'

// Re-export the override compiler types so consumers writing a custom
// `compileHasGrant` (etc.) can import them from the package they already
// install (`@flowchestra/prisma-guarddog`) instead of reaching into the
// emitter package or extracting via `NonNullable<RenderContext[...]>`.
export type {
  HasAppRoleCompiler,
  HasGrantCompiler,
  HasResourcePermissionCompiler,
  IsOwnerCompiler,
} from '@flowchestra/prisma-guarddog-emitter-postgres-rls'

export { formatSidecar, readAllSidecarOps, replayMigrationsDir, SIDECAR_FILENAME, SIDECAR_VERSION } from './sidecar.js'
export type { Sidecar } from './sidecar.js'
