/**
 * `guarddog adopt` — interactive, per-policy triage of the foreign RLS
 * policies already in a database (ADR-0030).
 *
 * Pipeline:
 *   1. Load the schema → declared state. Connect via `pg`.
 *   2. `readPolicyInventory` (ownership comments) + `readPgPolicies` (full
 *      SQL) → `computePolicyDrift` → the foreign policies to triage.
 *   3. For each, get a disposition (keep / remove / edit / override / skip) —
 *      from an injected `decide` (tests/CI) or an interactive TTY prompt.
 *   4. `planAdoption` → apply to the DB (keep = `:ignore` comment, remove =
 *      DROP) and emit a scaffold snippet (edit/override) to fold into
 *      `guarddog.ts`.
 *
 * Unlike `drift` (read-only), `adopt` writes — but only the comments/drops the
 * operator confirmed, scoped to foreign policies on managed tables.
 */

import { writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'

import { compileToState, type State } from '@flowchestra/prisma-guarddog-core'
import { quoteIdent } from '@flowchestra/prisma-guarddog-emitter-postgres-rls'
import { generateScaffold, readPgPolicies, readPolicyInventory } from '@flowchestra/prisma-guarddog-importer-postgres'
import pc from 'picocolors'

import type { ResolvedConfig } from '../config.js'
import {
  type AdoptionDisposition,
  type AdoptionPlan,
  computePolicyDrift,
  type ForeignPolicy,
  ignoreCommentSql,
  planAdoption,
} from '../drift.js'
import { loadSchema, SchemaLoadError } from '../load.js'

export type DecideFn = (
  foreign: ReadonlyArray<ForeignPolicy>
) => Promise<ReadonlyMap<string, AdoptionDisposition>> | ReadonlyMap<string, AdoptionDisposition>

export interface AdoptOptions {
  readonly config: ResolvedConfig
  readonly url: string
  readonly schema?: string
  /** Write the edit/override scaffold here instead of stdout. */
  readonly out?: string
  /** When true (default), writes a colored summary to stderr. */
  readonly stderr?: boolean
  /**
   * Per-policy decision source. Defaults to an interactive TTY prompt; tests
   * and `--plan` supply a deterministic map keyed `${table}::${policyName}`.
   */
  readonly decide?: DecideFn
}

export interface AdoptResult {
  readonly ok: boolean
  readonly plan: AdoptionPlan | undefined
  readonly scaffold: string
  readonly diagnostics: ReadonlyArray<string>
}

export async function runAdopt(opts: AdoptOptions): Promise<AdoptResult> {
  const writeStderr = opts.stderr ?? true
  const schema = opts.schema ?? 'public'

  let target: State
  try {
    const loaded = await loadSchema(opts.config.schemaPath)
    target = compileToState(loaded.guard)
  } catch (err) {
    return failure(err instanceof SchemaLoadError ? err.message : String(err), writeStderr)
  }

  let pgModule
  try {
    pgModule = (await import('pg')) as typeof import('pg')
  } catch (err) {
    return failure(`cannot load 'pg' — install it: \`pnpm add pg @types/pg\`. (${(err as Error).message})`, writeStderr)
  }
  const ClientCtor = (pgModule as unknown as { Client: typeof import('pg').Client }).Client
  const client = new ClientCtor({ connectionString: opts.url })
  try {
    await client.connect()
  } catch (err) {
    return failure(`failed to connect to ${redactUrl(opts.url)}: ${(err as Error).message}`, writeStderr)
  }

  try {
    const [inventory, rows] = await Promise.all([
      readPolicyInventory(client, { schema }),
      readPgPolicies(client, { schema }),
    ])
    const drift = computePolicyDrift(target, inventory)

    if (drift.foreign.length === 0) {
      if (writeStderr)
        process.stderr.write(`${pc.green('✓')} no foreign policies on managed tables — nothing to triage\n`)
      return Object.freeze({
        ok: true,
        plan: planAdoption([], new Map(), new Map()),
        scaffold: '',
        diagnostics: Object.freeze([]),
      })
    }

    const dispositions = await (opts.decide ?? promptDispositions)(drift.foreign)
    const rowsByKey = new Map(rows.map((r) => [`${r.table}::${r.policyName}`, r] as const))
    const plan = planAdoption(drift.foreign, rowsByKey, dispositions)

    // Apply DB-affecting dispositions: keep (ignore comment) + remove (drop).
    for (const k of plan.keep) await client.query(ignoreCommentSql(k.table, k.policyName))
    for (const op of plan.dropOps) {
      if (op.kind === 'drop-policy') {
        await client.query(`DROP POLICY IF EXISTS ${quoteIdent(op.name)} ON ${quoteIdent(op.table)};`)
      }
    }

    const scaffold = buildScaffold(plan)
    if (scaffold.length > 0) {
      if (opts.out !== undefined) await writeFile(opts.out, scaffold, 'utf8')
      else process.stdout.write(scaffold)
    }

    if (writeStderr) writeSummary(plan, opts.out)
    return Object.freeze({ ok: true, plan, scaffold, diagnostics: Object.freeze([]) })
  } finally {
    await client.end().catch(() => {})
  }
}

/** Scaffold text for `edit` (rawSql + todo via the importer) + `override` (fresh-author todos). */
function buildScaffold(plan: AdoptionPlan): string {
  const parts: string[] = []
  if (plan.editRows.length > 0) {
    parts.push(generateScaffold({ policies: plan.editRows, columnPrivileges: [] }))
  }
  if (plan.overrides.length > 0) {
    const lines = plan.overrides.map(
      (o) => `// TODO author a typed guarddog policy to replace "${o.policyName}" on ${o.table} (was FOR ${o.command})`
    )
    parts.push(['// --- override: author fresh typed policies for these ---', ...lines, ''].join('\n'))
  }
  return parts.join('\n')
}

const PROMPT = '[k]eep / [r]emove / [e]dit / [o]verride / [s]kip'
const KEY_TO_DISPOSITION: Readonly<Record<string, AdoptionDisposition>> = {
  k: 'keep',
  r: 'remove',
  e: 'edit',
  o: 'override',
  s: 'skip',
}

/** Default interactive prompt: ask per foreign policy on the TTY. */
async function promptDispositions(
  foreign: ReadonlyArray<ForeignPolicy>
): Promise<ReadonlyMap<string, AdoptionDisposition>> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const out = new Map<string, AdoptionDisposition>()
  try {
    process.stderr.write(
      `${pc.bold(`${foreign.length} foreign ${foreign.length === 1 ? 'policy' : 'policies'} to triage`)}\n`
    )
    for (const f of foreign) {
      const widen = f.permissive ? pc.red(' (permissive — may widen access)') : ''
      let disposition: AdoptionDisposition | undefined
      while (disposition === undefined) {
        const answer = (await rl.question(`  ${f.table}.${f.policyName} FOR ${f.command}${widen}\n  ${PROMPT}: `))
          .trim()
          .toLowerCase()
        disposition = KEY_TO_DISPOSITION[answer] ?? KEY_TO_DISPOSITION[answer[0] ?? '']
        if (disposition === undefined) process.stderr.write(`  ${pc.yellow('?')} pick one of ${PROMPT}\n`)
      }
      out.set(`${f.table}::${f.policyName}`, disposition)
    }
  } finally {
    rl.close()
  }
  return out
}

function writeSummary(plan: AdoptionPlan, out: string | undefined): void {
  const n = (a: ReadonlyArray<unknown>): number => a.length
  process.stderr.write(
    `${pc.green('✓')} adopt: ` +
      `${pc.dim('kept')} ${n(plan.keep)}  ${pc.dim('removed')} ${n(plan.dropOps)}  ` +
      `${pc.dim('edit')} ${n(plan.editRows)}  ${pc.dim('override')} ${n(plan.overrides)}  ${pc.dim('skipped')} ${n(plan.skipped)}\n`
  )
  if (plan.editRows.length + plan.overrides.length > 0) {
    const dest = out !== undefined ? out : 'stdout'
    process.stderr.write(
      `  ${pc.dim(`scaffold written to ${dest} — fold into guarddog.ts, then \`migrate --drop-unmanaged\``)}\n`
    )
  }
}

function failure(message: string, writeStderr: boolean): AdoptResult {
  if (writeStderr) process.stderr.write(`${pc.red('✗')} ${message}\n`)
  return Object.freeze({ ok: false, plan: undefined, scaffold: '', diagnostics: Object.freeze([message]) })
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
