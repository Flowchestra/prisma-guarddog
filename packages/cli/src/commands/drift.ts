/**
 * `guarddog drift` — compare the schema's declared policies against a LIVE
 * database and report drift (ADR-0029).
 *
 * Pipeline:
 *   1. Load the schema → target Guarddog → `compileToState` (declared state).
 *   2. Connect to the database URL via `pg` (lazy-imported) and
 *      `readPolicyInventory` (catalog policies + ownership comments).
 *   3. `computePolicyDrift` → foreign / stale-managed / missing, scoped to
 *      guarddog-managed tables.
 *   4. Print the report. With `--exit-code`, exit non-zero when drift exists
 *      (CI gate). Read-only — never modifies the database.
 *
 * The headline risk is `foreign` + `permissive`: a consumer's pre-existing
 * policy on a managed table ORs with guarddog's and can widen access. The
 * cutover (dropping them) is `guarddog migrate --drop-unmanaged`.
 */

import { compileToState, type State } from '@flowchestra/prisma-guarddog-core'
import { readPolicyInventory } from '@flowchestra/prisma-guarddog-importer-postgres'
import pc from 'picocolors'

import type { ResolvedConfig } from '../config.js'
import { computePolicyDrift, type PolicyDrift } from '../drift.js'
import { loadSchema, SchemaLoadError } from '../load.js'

export interface DriftOptions {
  readonly config: ResolvedConfig
  /** Postgres connection string to compare against. */
  readonly url: string
  /** Postgres schema to inspect (default `public`). */
  readonly schema?: string
  /** When true, `runDrift` returns `ok: false` if any drift exists (CI gate). Default false. */
  readonly exitCode?: boolean
  /** When true (default), writes a colored report to stdout. */
  readonly stdout?: boolean
}

export interface DriftResult {
  readonly ok: boolean
  readonly drift: PolicyDrift | undefined
  readonly diagnostics: ReadonlyArray<string>
}

export async function runDrift(opts: DriftOptions): Promise<DriftResult> {
  const writeStdout = opts.stdout ?? true
  const exitCode = opts.exitCode ?? false
  const schema = opts.schema ?? 'public'

  let target: State
  try {
    const loaded = await loadSchema(opts.config.schemaPath)
    target = compileToState(loaded.guard)
  } catch (err) {
    return failure(err instanceof SchemaLoadError ? err.message : String(err), writeStdout)
  }

  let pgModule
  try {
    pgModule = (await import('pg')) as typeof import('pg')
  } catch (err) {
    return failure(
      `cannot load 'pg' — install it as a peer dependency: \`pnpm add pg @types/pg\`. (${(err as Error).message})`,
      writeStdout
    )
  }
  const ClientCtor = (pgModule as unknown as { Client: typeof import('pg').Client }).Client
  const client = new ClientCtor({ connectionString: opts.url })

  try {
    await client.connect()
  } catch (err) {
    return failure(`failed to connect to ${redactUrl(opts.url)}: ${(err as Error).message}`, writeStdout)
  }

  let drift: PolicyDrift
  try {
    const inventory = await readPolicyInventory(client, { schema })
    drift = computePolicyDrift(target, inventory)
  } finally {
    await client.end().catch(() => {})
  }

  if (writeStdout) writeReport(drift)
  return Object.freeze({ ok: !exitCode || drift.ok, drift, diagnostics: Object.freeze([]) })
}

function writeReport(drift: PolicyDrift): void {
  if (drift.ok) {
    process.stdout.write(`${pc.green('✓')} no policy drift — live database matches the declared schema\n`)
    return
  }

  const wideners = drift.foreign.filter((f) => f.permissive)
  if (wideners.length > 0) {
    process.stdout.write(
      `${pc.red('✗')} ${wideners.length} foreign permissive ${plural(wideners.length, 'policy', 'policies')} on managed ` +
        `${plural(wideners.length, 'table', 'tables')} — these OR with guarddog's policies and may WIDEN access:\n`
    )
    for (const f of wideners) {
      process.stdout.write(`  ${pc.red('•')} ${f.table}.${f.policyName} ${pc.dim(`(FOR ${f.command})`)}\n`)
    }
    process.stdout.write(`  ${pc.dim('→ remove with `guarddog migrate --drop-unmanaged`')}\n`)
  }

  const restrictiveForeign = drift.foreign.filter((f) => !f.permissive)
  for (const f of restrictiveForeign) {
    process.stdout.write(
      `  ${pc.yellow('•')} foreign restrictive ${f.table}.${f.policyName} ${pc.dim(`(FOR ${f.command})`)}\n`
    )
  }
  for (const s of drift.staleManaged) {
    process.stdout.write(
      `  ${pc.yellow('•')} stale guarddog-managed ${s.table}.${s.policyName} ${pc.dim('(no longer declared)')}\n`
    )
  }
  for (const m of drift.missing) {
    process.stdout.write(`  ${pc.yellow('•')} declared but missing in DB: ${m.table}.${m.policyName}\n`)
  }
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

function failure(message: string, writeStdout: boolean): DriftResult {
  if (writeStdout) process.stderr.write(`${pc.red('✗')} ${message}\n`)
  return Object.freeze({ ok: false, drift: undefined, diagnostics: Object.freeze([message]) })
}

// Duplicated from commands/import.ts (small, security-sensitive) — strips
// credentials before a connection string lands in a diagnostic / CI log.
function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.password !== '') u.password = '***'
    if (u.username !== '' && u.password === '***') u.username = '***'
    return u.toString()
  } catch {
    return url.replace(/:\/\/[^@]+@/, '://***@')
  }
}
