/**
 * Config resolution for the `prisma-guarddog` CLI.
 *
 * Resolution order per ADR-0009:
 *   1. Explicit values from a `guarddog.config.ts` file (loaded via jiti).
 *   2. Paths read from a `prisma.config.ts` file (when present).
 *   3. Conventional defaults: `prisma/guarddog.ts`, `prisma/schema.prisma`,
 *      `prisma/migrations/`.
 *
 * Phase 1 implements (1) and (3). Reading `prisma.config.ts` is a Phase 2
 * follow-up; for now consumers using non-default Prisma paths point at
 * them via `guarddog.config.ts`.
 *
 * `resolveConfig` is a pure function — no filesystem access. The
 * `discoverConfig` helper one level up loads the config file (if any)
 * and folds it into the resolved shape.
 */

import { existsSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createJiti } from 'jiti'

export interface ResolvedConfig {
  /** Absolute path to the working directory used for relative resolution. */
  readonly cwd: string
  /** Absolute path to the guarddog schema file (default `prisma/guarddog.ts`). */
  readonly schemaPath: string
  /** Absolute path to the Prisma schema file (default `prisma/schema.prisma`). */
  readonly prismaSchemaPath: string
  /** Absolute path to the migrations directory (default `prisma/migrations`). */
  readonly migrationsDir: string
  /** Filename extension for sidecar metadata (default `.guarddog.json`). */
  readonly metadataExt: string
}

/**
 * The shape a user `export default`s from a `guarddog.config.ts` file. All
 * fields are optional and override the corresponding defaults; relative
 * paths resolve against the config file's directory.
 */
export interface GuarddogConfigFile {
  readonly schemaPath?: string
  readonly prismaSchemaPath?: string
  readonly migrationsDir?: string
  readonly metadataExt?: string
}

export interface ResolveConfigOptions {
  readonly cwd?: string
  readonly overrides?: GuarddogConfigFile
  /** Base path against which relative overrides resolve. Defaults to cwd. */
  readonly overridesBase?: string
}

/**
 * Pure config resolution — no I/O. Applies the override layer on top of
 * the conventional defaults rooted at `cwd`. Relative path overrides
 * resolve against `overridesBase` (defaults to `cwd`).
 */
export function resolveConfig(opts: ResolveConfigOptions = {}): ResolvedConfig {
  const cwd = opts.cwd ?? process.cwd()
  const overrides = opts.overrides ?? {}
  const base = opts.overridesBase ?? cwd

  const resolveAgainstBase = (p: string | undefined, fallback: string): string => {
    if (p === undefined) return fallback
    return isAbsolute(p) ? p : resolve(base, p)
  }

  return Object.freeze({
    cwd,
    schemaPath: resolveAgainstBase(overrides.schemaPath, resolve(cwd, 'prisma', 'guarddog.ts')),
    prismaSchemaPath: resolveAgainstBase(overrides.prismaSchemaPath, resolve(cwd, 'prisma', 'schema.prisma')),
    migrationsDir: resolveAgainstBase(overrides.migrationsDir, resolve(cwd, 'prisma', 'migrations')),
    metadataExt: overrides.metadataExt ?? '.guarddog.json',
  })
}

/**
 * Locate `guarddog.config.ts` (or `.js`) in `cwd`. Returns the absolute path
 * if it exists, undefined otherwise. The CLI walks up parent directories
 * is intentionally NOT done — like Prisma, we expect the config to live in
 * the project root the command is invoked from.
 */
export function findConfigFile(cwd: string): string | undefined {
  for (const name of ['guarddog.config.ts', 'guarddog.config.js', 'guarddog.config.mjs']) {
    const candidate = resolve(cwd, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Load a `guarddog.config.{ts,js,mjs}` file via jiti and validate its shape.
 * Returns the file contents (passed through as `GuarddogConfigFile`) plus
 * the resolved base directory for relative paths.
 *
 * This is the only function in this module that performs I/O. Tests should
 * exercise `resolveConfig` directly with synthetic overrides.
 */
export async function loadConfigFile(configPath: string): Promise<{
  readonly overrides: GuarddogConfigFile
  readonly base: string
}> {
  const jiti = createJiti(fileURLToPath(import.meta.url))
  const loaded = (await jiti.import(configPath)) as { default?: GuarddogConfigFile } | GuarddogConfigFile
  const overrides =
    'default' in loaded && loaded.default !== undefined ? loaded.default : (loaded as GuarddogConfigFile)
  return Object.freeze({ overrides: Object.freeze({ ...overrides }), base: dirname(configPath) })
}

/**
 * Full discovery: locate `guarddog.config.*` in `cwd`, load it if found,
 * fold its overrides into the conventional defaults, return the resolved
 * shape. The CLI's bin script calls this once per invocation.
 */
export async function discoverConfig(cwd: string = process.cwd()): Promise<ResolvedConfig> {
  const configPath = findConfigFile(cwd)
  if (configPath === undefined) {
    return resolveConfig({ cwd })
  }
  const { overrides, base } = await loadConfigFile(configPath)
  return resolveConfig({ cwd, overrides, overridesBase: base })
}
