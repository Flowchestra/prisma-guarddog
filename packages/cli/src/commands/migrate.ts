/**
 * `guarddog migrate` — write the next idempotent migration.
 *
 * Pipeline:
 *
 *   1. Load the user's schema (via `loadSchema`) → target Guarddog.
 *   2. Forward-replay every existing `guarddog.json` sidecar under the
 *      configured migrations dir → current State.
 *   3. `compileToState(guard)` → target State.
 *   4. `diffStates(current, target)` → the Op sequence to apply.
 *   5. If empty: print "no changes" and exit cleanly.
 *   6. Otherwise: render the ops to SQL via `renderOps`, allocate a fresh
 *      `prisma/migrations/<YYYYMMDDHHMMSS>_<slug>/` folder, write
 *      `migration.sql` and `guarddog.json` into it.
 *
 * The migration folder is Prisma-shaped so `prisma migrate dev` (or
 * `deploy`) picks the SQL up alongside any Prisma-authored migrations.
 * The sidecar lives in the same folder so the next `migrate` run can
 * forward-replay it.
 *
 * Pure-but-side-effectful: every step exposes a structured result for
 * tests; the orchestrator (`runMigrate`) handles I/O and stdout. Tests
 * can call `planMigrate` to get the rendered SQL + ops without writing.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { compileToState, diffStates, type Guarddog, type Op, type State } from '@flowchestra/prisma-guarddog-core'
import { readPolicyInventory } from '@flowchestra/prisma-guarddog-importer-postgres'
import pc from 'picocolors'

import type { ResolvedConfig } from '../config.js'
import { computePolicyDrift, driftToDropOps } from '../drift.js'
import { loadSchema, SchemaLoadError } from '../load.js'
import { renderOps, type RenderOverrides } from '../render-ops.js'
import { formatSidecar, replayMigrationsDir, SIDECAR_FILENAME } from '../sidecar.js'

export interface MigratePlan {
  readonly ops: readonly Op[]
  readonly sql: readonly string[]
  readonly current: State
  readonly target: State
}

export interface MigrateOptions {
  readonly config: ResolvedConfig
  /** Slug appended to the migration folder name (default `guarddog`). */
  readonly slug?: string
  /** Override the timestamp prefix; for deterministic tests. */
  readonly now?: () => Date
  /** When true (default), writes a colored summary to stdout. */
  readonly stdout?: boolean
  /**
   * Cutover (ADR-0029): when true (with `databaseUrl` set), read the live
   * policy inventory and prepend `DROP POLICY` for every foreign /
   * stale-managed policy on a managed table, so the migration removes legacy
   * policies before creating guarddog's. Opt-in — never drops on the default
   * path.
   */
  readonly dropUnmanaged?: boolean
  /** Postgres URL to read live policies from; required when `dropUnmanaged` is set. */
  readonly databaseUrl?: string
  /** Postgres schema to inspect for `--drop-unmanaged` (default `public`). */
  readonly schema?: string
}

export interface MigrateResult {
  readonly ok: boolean
  readonly noChanges: boolean
  readonly migrationDir: string | undefined
  readonly opCount: number
  readonly diagnostics: ReadonlyArray<string>
}

/**
 * Pure planning step: derive ops + rendered SQL without writing anything.
 * Exposed for tests and for a future `migrate --dry-run` flag.
 *
 * `renderOverrides` (optional) threads consumer-supplied predicate compilers
 * — `compileHasGrant` and friends — into `renderOps`. `runMigrate` forwards
 * `config.renderOverrides` here; direct callers can pass their own.
 */
export function planMigrate(
  guard: Guarddog,
  current: State,
  renderOverrides: RenderOverrides = {},
  // Ops prepended ahead of the computed diff — used by `--drop-unmanaged` to
  // drop foreign/legacy policies before guarddog creates its own (ADR-0029).
  leadingOps: ReadonlyArray<Op> = []
): MigratePlan {
  const target = compileToState(guard)
  const ops = Object.freeze([...leadingOps, ...diffStates(current, target)])
  const sql = renderOps(ops, {
    claims: guard.config.claims,
    ...(guard.config.resourceGrants !== undefined && { resourceGrants: guard.config.resourceGrants }),
    ...(guard.config.functions !== undefined && { functionSchema: guard.config.functions.schema }),
    ...renderOverrides,
  })
  return Object.freeze({ ops, sql, current, target })
}

/**
 * Read the live policy inventory and compute the `DROP POLICY` ops for
 * foreign / stale-managed policies on managed tables (the `--drop-unmanaged`
 * cutover). Returns `[]` on any connection/read failure with a diagnostic, so
 * a missing/unreachable DB degrades to "no extra drops" rather than aborting.
 */
async function computeDropUnmanagedOps(
  guard: Guarddog,
  databaseUrl: string,
  schema: string
): Promise<{ readonly ops: ReadonlyArray<Op>; readonly diagnostics: ReadonlyArray<string> }> {
  let pgModule
  try {
    pgModule = (await import('pg')) as typeof import('pg')
  } catch (err) {
    return { ops: [], diagnostics: [`--drop-unmanaged: cannot load 'pg' (${(err as Error).message})`] }
  }
  const ClientCtor = (pgModule as unknown as { Client: typeof import('pg').Client }).Client
  const client = new ClientCtor({ connectionString: databaseUrl })
  try {
    await client.connect()
  } catch (err) {
    return { ops: [], diagnostics: [`--drop-unmanaged: failed to connect: ${(err as Error).message}`] }
  }
  try {
    const inventory = await readPolicyInventory(client, { schema })
    const drift = computePolicyDrift(compileToState(guard), inventory)
    return { ops: driftToDropOps(drift), diagnostics: [] }
  } finally {
    await client.end().catch(() => {})
  }
}

export async function runMigrate(opts: MigrateOptions): Promise<MigrateResult> {
  const { config } = opts
  const writeStdout = opts.stdout ?? true
  const slug = opts.slug ?? 'guarddog'

  let loaded
  try {
    loaded = await loadSchema(config.schemaPath)
  } catch (err) {
    return failure(err instanceof SchemaLoadError ? err.message : String(err), writeStdout)
  }

  const current = await replayMigrationsDir(config.migrationsDir)

  let leadingOps: ReadonlyArray<Op> = []
  const diagnostics: string[] = []
  if (opts.dropUnmanaged === true) {
    if (opts.databaseUrl === undefined || opts.databaseUrl.length === 0) {
      return failure('--drop-unmanaged requires a database URL (--against or GUARDDOG_DATABASE_URL)', writeStdout)
    }
    const dropPlan = await computeDropUnmanagedOps(loaded.guard, opts.databaseUrl, opts.schema ?? 'public')
    leadingOps = dropPlan.ops
    diagnostics.push(...dropPlan.diagnostics)
  }

  const plan = planMigrate(loaded.guard, current, config.renderOverrides, leadingOps)

  if (writeStdout) {
    for (const diag of diagnostics) process.stderr.write(`${pc.yellow('!')} ${diag}\n`)
  }

  if (plan.ops.length === 0) {
    if (writeStdout) {
      process.stdout.write(`${pc.green('✓')} no changes — schema and migrations are in sync\n`)
    }
    return Object.freeze({
      ok: true,
      noChanges: true,
      migrationDir: undefined,
      opCount: 0,
      diagnostics: Object.freeze([...diagnostics]),
    })
  }

  const timestamp = formatTimestamp((opts.now ?? (() => new Date()))())
  const folder = `${timestamp}_${slug}`
  const migrationDir = join(config.migrationsDir, folder)
  await mkdir(migrationDir, { recursive: true })

  const sqlPath = join(migrationDir, 'migration.sql')
  const sidecarPath = join(migrationDir, SIDECAR_FILENAME)
  await writeFile(sqlPath, formatMigrationSql(plan.sql), 'utf8')
  await writeFile(sidecarPath, formatSidecar(plan.ops), 'utf8')

  if (writeStdout) {
    process.stdout.write(
      `${pc.green('✓')} wrote ${pc.dim(folder)} ${pc.dim(`(${plan.ops.length} ops)`)}\n` +
        `  ${pc.dim('sql:')} ${sqlPath}\n` +
        `  ${pc.dim('sidecar:')} ${sidecarPath}\n`
    )
  }

  return Object.freeze({
    ok: true,
    noChanges: false,
    migrationDir,
    opCount: plan.ops.length,
    diagnostics: Object.freeze([...diagnostics]),
  })
}

function failure(message: string, writeStdout: boolean): MigrateResult {
  if (writeStdout) process.stderr.write(`${pc.red('✗')} ${message}\n`)
  return Object.freeze({
    ok: false,
    noChanges: false,
    migrationDir: undefined,
    opCount: 0,
    diagnostics: Object.freeze([message]),
  })
}

function formatMigrationSql(statements: ReadonlyArray<string>): string {
  const banner = '-- prisma-guarddog: generated migration. Do not hand-edit; re-run `guarddog migrate` instead.\n'
  return `${banner}\n${statements.join('\n\n')}\n`
}

/**
 * Prisma's migration-folder convention is `YYYYMMDDHHMMSS_<name>` in UTC.
 * We mirror it exactly so Prisma's CLI orders our folders correctly in its
 * own listings.
 */
function formatTimestamp(now: Date): string {
  return (
    `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}` +
    `${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}`
  )
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}
