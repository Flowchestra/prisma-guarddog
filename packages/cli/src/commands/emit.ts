/**
 * `guarddog emit` — render the full schema as SQL.
 *
 * Diffs the loaded schema against an empty starting state and renders the
 * resulting Op list to Postgres DDL. Equivalent to "what SQL would I need
 * to bring an empty database to this schema's state?" — useful for inline
 * inspection, ad-hoc copy-paste into psql, and CI artifacts that want a
 * deterministic SQL snapshot of the policy graph.
 *
 * No file I/O by default — SQL goes to stdout. Pass `--out <path>` to
 * write it to a file instead. This is a *read-only* command: it does not
 * touch the migrations directory, does not create sidecars, and does not
 * replay any prior history. For that, see `guarddog migrate`.
 */

import { writeFile } from 'node:fs/promises'

import { empty, type Op } from '@flowchestra/prisma-guarddog-core'
import pc from 'picocolors'

import type { ResolvedConfig } from '../config.js'
import { loadSchema, SchemaLoadError } from '../load.js'
import { planMigrate } from './migrate.js'

export interface EmitOptions {
  readonly config: ResolvedConfig
  /** Optional output file path. When omitted, SQL goes to stdout. */
  readonly out?: string
  /** When true (default), writes a colored summary to stderr. */
  readonly stderr?: boolean
}

export interface EmitResult {
  readonly ok: boolean
  readonly ops: readonly Op[]
  readonly sql: readonly string[]
  readonly outPath: string | undefined
  readonly diagnostics: ReadonlyArray<string>
}

export async function runEmit(opts: EmitOptions): Promise<EmitResult> {
  const { config } = opts
  const writeStderr = opts.stderr ?? true

  let loaded
  try {
    loaded = await loadSchema(config.schemaPath)
  } catch (err) {
    return failure(err instanceof SchemaLoadError ? err.message : String(err), writeStderr)
  }

  const plan = planMigrate(loaded.guard, empty())
  const sql = formatSqlBlock(plan.sql)

  if (opts.out !== undefined) {
    await writeFile(opts.out, sql, 'utf8')
    if (writeStderr) {
      process.stderr.write(`${pc.green('✓')} wrote ${pc.dim(opts.out)} ${pc.dim(`(${plan.ops.length} ops)`)}\n`)
    }
  } else {
    process.stdout.write(sql)
    if (writeStderr) {
      process.stderr.write(`${pc.green('✓')} emitted ${pc.dim(`${plan.ops.length} ops`)}\n`)
    }
  }

  return Object.freeze({
    ok: true,
    ops: plan.ops,
    sql: plan.sql,
    outPath: opts.out,
    diagnostics: Object.freeze([]),
  })
}

function failure(message: string, writeStderr: boolean): EmitResult {
  if (writeStderr) process.stderr.write(`${pc.red('✗')} ${message}\n`)
  return Object.freeze({
    ok: false,
    ops: Object.freeze([]),
    sql: Object.freeze([]),
    outPath: undefined,
    diagnostics: Object.freeze([message]),
  })
}

function formatSqlBlock(statements: ReadonlyArray<string>): string {
  const banner = '-- prisma-guarddog: ad-hoc emit. Not a migration; do not commit. Re-run via `guarddog emit`.\n'
  return `${banner}\n${statements.join('\n\n')}\n`
}
