/**
 * Config resolution for the `prisma-guarddog` CLI.
 *
 * Resolution order per ADR-0009 (highest precedence first):
 *   1. Explicit values from a `guarddog.config.ts` file (loaded via jiti).
 *   2. Paths read from a `prisma.config.ts` file (when present): the Prisma
 *      `schema` location and `migrations.path` feed guarddog's
 *      `prismaSchemaPath` / `migrationsDir` so guarddog follows wherever the
 *      consumer put their Prisma schema + migrations instead of assuming
 *      `prisma/`.
 *   3. Conventional defaults: `prisma/guarddog.ts`, `prisma/schema.prisma`,
 *      `prisma/migrations/`.
 *
 * `resolveConfig` is a pure function — no filesystem access; the
 * `prisma.config.ts`-derived paths are passed in as `prismaDefaults`. The
 * `discoverConfig` helper one level up loads both config files (if present)
 * and folds them into the resolved shape.
 */

import { existsSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createJiti } from 'jiti'

import type { RenderOverrides } from './render-ops.js'

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
  /**
   * Predicate-compiler overrides forwarded into `renderOps`. Empty unless
   * the consumer's `guarddog.config.ts` declares `renderOverrides`. Lets a
   * consumer with a non-default authorization model (rank-based grants,
   * user-OR-group disjunction, etc.) plug a `compileHasGrant` through the
   * stock `guarddog migrate` CLI instead of reimplementing the pipeline.
   */
  readonly renderOverrides: RenderOverrides
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
  /**
   * Override compilers threaded into `renderOps` by `guarddog migrate` /
   * `diff` / `emit`. Carries functions, so the config file must be a
   * `.ts`/`.js` module (it already is — loaded via jiti). See ADR-0024.
   */
  readonly renderOverrides?: RenderOverrides
}

/**
 * Path hints extracted from a consumer's `prisma.config.ts`. Both are
 * already resolved to absolute paths by {@link loadPrismaConfig}. They sit
 * below `guarddog.config.ts` overrides and above the conventional defaults.
 */
export interface PrismaConfigPaths {
  readonly prismaSchemaPath?: string
  readonly migrationsDir?: string
}

export interface ResolveConfigOptions {
  readonly cwd?: string
  readonly overrides?: GuarddogConfigFile
  /** Base path against which relative overrides resolve. Defaults to cwd. */
  readonly overridesBase?: string
  /** Absolute path hints from `prisma.config.ts`; used as defaults below overrides. */
  readonly prismaDefaults?: PrismaConfigPaths
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
  const prismaDefaults = opts.prismaDefaults ?? {}

  const resolveAgainstBase = (p: string | undefined, fallback: string): string => {
    if (p === undefined) return fallback
    return isAbsolute(p) ? p : resolve(base, p)
  }

  return Object.freeze({
    cwd,
    schemaPath: resolveAgainstBase(overrides.schemaPath, resolve(cwd, 'prisma', 'guarddog.ts')),
    prismaSchemaPath: resolveAgainstBase(
      overrides.prismaSchemaPath,
      prismaDefaults.prismaSchemaPath ?? resolve(cwd, 'prisma', 'schema.prisma')
    ),
    migrationsDir: resolveAgainstBase(
      overrides.migrationsDir,
      prismaDefaults.migrationsDir ?? resolve(cwd, 'prisma', 'migrations')
    ),
    metadataExt: overrides.metadataExt ?? '.guarddog.json',
    // Functions, not paths — passed through verbatim. Frozen shallow copy so
    // the resolved config can't be mutated, but the compiler fns are shared.
    // Spreading `undefined` is a no-op, so no `?? {}` fallback is needed.
    renderOverrides: Object.freeze({ ...overrides.renderOverrides }),
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
 * Locate `prisma.config.ts` (or `.js`/`.mjs`) in `cwd`. Same root-only
 * lookup as {@link findConfigFile} — no parent-directory walk.
 */
export function findPrismaConfigFile(cwd: string): string | undefined {
  for (const name of ['prisma.config.ts', 'prisma.config.js', 'prisma.config.mjs']) {
    const candidate = resolve(cwd, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Read the consumer's `prisma.config.ts` and pull out the two paths guarddog
 * cares about: the Prisma `schema` location and `migrations.path`. Relative
 * values resolve against the config file's directory.
 *
 * Lenient by design: `prisma.config.ts` belongs to Prisma, not guarddog. If
 * it can't be loaded (jiti error, unexpected imports) we warn and fall back
 * to conventions rather than failing the command — but we never *silently*
 * ignore a present-but-broken config.
 */
export async function loadPrismaConfig(configPath: string): Promise<PrismaConfigPaths> {
  const jiti = createJiti(fileURLToPath(import.meta.url))
  let loaded: unknown
  try {
    loaded = await jiti.import(configPath)
  } catch (err) {
    process.stderr.write(
      `[prisma-guarddog] found ${configPath} but could not load it (${(err as Error).message}); ` +
        'falling back to default Prisma paths.\n'
    )
    return Object.freeze({})
  }

  const cfg =
    typeof loaded === 'object' && loaded !== null && 'default' in loaded && (loaded as { default?: unknown }).default
      ? (loaded as { default: unknown }).default
      : loaded
  if (typeof cfg !== 'object' || cfg === null) return Object.freeze({})

  const baseDir = dirname(configPath)
  const toAbs = (p: string): string => (isAbsolute(p) ? p : resolve(baseDir, p))

  const out: { prismaSchemaPath?: string; migrationsDir?: string } = {}
  const schema = (cfg as { schema?: unknown }).schema
  if (typeof schema === 'string' && schema.length > 0) {
    out.prismaSchemaPath = toAbs(schema)
  }
  const migrations = (cfg as { migrations?: unknown }).migrations
  if (typeof migrations === 'object' && migrations !== null) {
    const path = (migrations as { path?: unknown }).path
    if (typeof path === 'string' && path.length > 0) {
      out.migrationsDir = toAbs(path)
    }
  }
  return Object.freeze(out)
}

/**
 * Full discovery: read `prisma.config.*` (if present) for path hints, locate
 * + load `guarddog.config.*` (if present), and fold both into the
 * conventional defaults — guarddog.config wins over prisma.config wins over
 * conventions. The CLI's bin script calls this once per invocation.
 */
export async function discoverConfig(cwd: string = process.cwd()): Promise<ResolvedConfig> {
  const prismaConfigPath = findPrismaConfigFile(cwd)
  const prismaDefaults = prismaConfigPath !== undefined ? await loadPrismaConfig(prismaConfigPath) : {}

  const configPath = findConfigFile(cwd)
  if (configPath === undefined) {
    return resolveConfig({ cwd, prismaDefaults })
  }
  const { overrides, base } = await loadConfigFile(configPath)
  return resolveConfig({ cwd, overrides, overridesBase: base, prismaDefaults })
}
