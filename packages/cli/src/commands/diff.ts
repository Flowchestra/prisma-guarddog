/**
 * `guarddog diff` — show what `guarddog migrate` *would* write, without
 * actually writing anything.
 *
 * Pipeline mirrors `migrate` exactly:
 *
 *   1. Load the user's schema → target Guarddog.
 *   2. Forward-replay every existing sidecar → current State.
 *   3. `planMigrate(guard, current)` → the Op sequence + rendered SQL
 *      that the next `migrate` invocation would emit.
 *
 * Pure read — no file I/O. Exits 0 when there are no changes; exits 0
 * with output when there are changes (this is informational, not a CI
 * gate). For a CI-style "fail if drift exists" check, pass `--exit-code`
 * (mirrors `git diff --exit-code`).
 */

import { empty, type Op, type State } from '@flowchestra/prisma-guarddog-core'
import pc from 'picocolors'

import type { ResolvedConfig } from '../config.js'
import { loadSchema, SchemaLoadError } from '../load.js'
import { replayMigrationsDir } from '../sidecar.js'
import { planMigrate } from './migrate.js'

export interface DiffOptions {
  readonly config: ResolvedConfig
  /**
   * When true, `runDiff` returns `ok: false` if there are pending ops
   * (suitable for CI gating that requires the migrations directory to be
   * in sync with the schema). Default false.
   */
  readonly exitCode?: boolean
  /** When true (default), writes a colored summary + SQL to stdout. */
  readonly stdout?: boolean
}

export interface DiffResult {
  readonly ok: boolean
  readonly hasChanges: boolean
  readonly ops: readonly Op[]
  readonly sql: readonly string[]
  readonly current: State
  readonly diagnostics: ReadonlyArray<string>
}

export async function runDiff(opts: DiffOptions): Promise<DiffResult> {
  const { config } = opts
  const writeStdout = opts.stdout ?? true
  const exitCode = opts.exitCode ?? false

  let loaded
  try {
    loaded = await loadSchema(config.schemaPath)
  } catch (err) {
    return failure(err instanceof SchemaLoadError ? err.message : String(err), writeStdout)
  }

  const current = await replayMigrationsDir(config.migrationsDir)
  const plan = planMigrate(loaded.guard, current, config.renderOverrides)
  const hasChanges = plan.ops.length > 0

  if (writeStdout) writeSummary(plan.ops, plan.sql, hasChanges)

  return Object.freeze({
    ok: !exitCode || !hasChanges,
    hasChanges,
    ops: plan.ops,
    sql: plan.sql,
    current,
    diagnostics: Object.freeze([]),
  })
}

function failure(message: string, writeStdout: boolean): DiffResult {
  if (writeStdout) process.stderr.write(`${pc.red('✗')} ${message}\n`)
  return Object.freeze({
    ok: false,
    hasChanges: false,
    ops: Object.freeze([]),
    sql: Object.freeze([]),
    current: empty(),
    diagnostics: Object.freeze([message]),
  })
}

function writeSummary(ops: ReadonlyArray<Op>, sql: ReadonlyArray<string>, hasChanges: boolean): void {
  if (!hasChanges) {
    process.stdout.write(`${pc.green('✓')} no pending changes — schema and migrations are in sync\n`)
    return
  }
  process.stdout.write(`${pc.yellow('●')} ${ops.length} pending op(s) — `)
  process.stdout.write(`${pc.dim('run `guarddog migrate` to write the migration')}\n\n`)
  for (const stmt of sql) {
    process.stdout.write(`${stmt}\n\n`)
  }
}
