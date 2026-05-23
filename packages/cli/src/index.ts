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
