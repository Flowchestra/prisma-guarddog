/**
 * Migration sidecar format and forward-replay over the migrations directory.
 *
 * Each guarddog-authored migration drops two files into its migration
 * folder under `prisma/migrations/<timestamp>_<slug>/`:
 *
 *   - `migration.sql`  — idempotent DDL applied by Prisma's migration runner.
 *   - `guarddog.json`  — the {@link Sidecar} payload, recording the typed Op
 *                        sequence that produced the SQL.
 *
 * Forward replay of every sidecar under the migrations directory (in
 * lexicographic folder order, which sorts to chronological order given the
 * Prisma timestamp prefix) reconstructs the declared state. The migrate
 * command diffs this current state against `compileToState(schema)` to
 * produce the next migration's ops.
 *
 * Schema is intentionally minimal — version, ops, and a comment hint —
 * to keep the file readable in PR review and to make future schema
 * changes easy (bump `version`, branch the parser).
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { applyOps, empty, type Op, type State } from '@flowchestra/prisma-guarddog-core'

export const SIDECAR_FILENAME = 'guarddog.json'
export const SIDECAR_VERSION = 1

export interface Sidecar {
  readonly version: number
  readonly ops: ReadonlyArray<Op>
}

/**
 * Walk `migrationsDir`, read every `guarddog.json` found inside an
 * immediate subdirectory, concatenate the ops in lexicographic folder
 * order, and forward-replay into a {@link State}. Missing directory or
 * directories without sidecars yield an empty state.
 */
export async function replayMigrationsDir(migrationsDir: string): Promise<State> {
  const ops = await readAllSidecarOps(migrationsDir)
  return applyOps(empty(), ops)
}

/**
 * Read every sidecar found in `migrationsDir/*\/guarddog.json` and return
 * the concatenation of their ops in lexicographic folder order. Useful for
 * `migrate --print` and for tests that want to inspect the raw replay
 * stream without materializing a State.
 */
export async function readAllSidecarOps(migrationsDir: string): Promise<readonly Op[]> {
  const entries = await safeReaddir(migrationsDir)
  const folders = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  folders.sort()

  const sidecars = await Promise.all(
    folders.map((folder) => readSidecar(join(migrationsDir, folder, SIDECAR_FILENAME)))
  )
  const out: Op[] = []
  for (const sidecar of sidecars) {
    if (sidecar !== undefined) out.push(...sidecar.ops)
  }
  return Object.freeze(out)
}

async function readSidecar(path: string): Promise<Sidecar | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  const parsed = JSON.parse(raw) as Sidecar
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`[prisma-guarddog] ${path} is not a valid guarddog sidecar (expected an object).`)
  }
  if (parsed.version !== SIDECAR_VERSION) {
    throw new Error(
      `[prisma-guarddog] ${path}: unsupported sidecar version ${parsed.version}. ` +
        `Expected ${SIDECAR_VERSION}. Upgrade prisma-guarddog or regenerate the sidecar.`
    )
  }
  if (!Array.isArray(parsed.ops)) {
    throw new Error(`[prisma-guarddog] ${path}: sidecar 'ops' must be an array.`)
  }
  return parsed
}

async function safeReaddir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/** Serialize a sidecar to JSON with stable formatting suitable for git diffs. */
export function formatSidecar(ops: ReadonlyArray<Op>): string {
  return `${JSON.stringify({ version: SIDECAR_VERSION, ops }, null, 2)}\n`
}
