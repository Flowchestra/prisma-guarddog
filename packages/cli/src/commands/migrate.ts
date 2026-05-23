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

import { compileToState, diffStates, type Guarddog, type Op, type State } from '@prisma-guarddog/core'
import pc from 'picocolors'

import type { ResolvedConfig } from '../config.js'
import { loadSchema, SchemaLoadError } from '../load.js'
import { renderOps } from '../render-ops.js'
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
 */
export function planMigrate(guard: Guarddog, current: State): MigratePlan {
  const target = compileToState(guard)
  const ops = diffStates(current, target)
  const sql = renderOps(ops, {
    claims: guard.config.claims,
    ...(guard.config.resourceGrants !== undefined && { resourceGrants: guard.config.resourceGrants }),
  })
  return Object.freeze({ ops, sql, current, target })
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
  const plan = planMigrate(loaded.guard, current)

  if (plan.ops.length === 0) {
    if (writeStdout) {
      process.stdout.write(`${pc.green('✓')} no changes — schema and migrations are in sync\n`)
    }
    return Object.freeze({
      ok: true,
      noChanges: true,
      migrationDir: undefined,
      opCount: 0,
      diagnostics: Object.freeze([]),
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
    diagnostics: Object.freeze([]),
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
