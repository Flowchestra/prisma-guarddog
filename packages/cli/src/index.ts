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

export { renderOps } from './render-ops.js'
export type { RenderContext } from './render-ops.js'

export { formatSidecar, readAllSidecarOps, replayMigrationsDir, SIDECAR_FILENAME, SIDECAR_VERSION } from './sidecar.js'
export type { Sidecar } from './sidecar.js'
