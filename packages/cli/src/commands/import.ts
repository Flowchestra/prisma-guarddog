/**
 * `guarddog import` — scaffold a `guarddog.ts` from an existing Postgres
 * database's `pg_policies` + column-privilege state.
 *
 * Pipeline:
 *
 *   1. Connect to the configured Postgres URL via `pg` (lazy-imported so
 *      consumers without `pg` installed get a useful error rather than a
 *      crash inside this module's import graph).
 *   2. `readPgPolicies` + `readColumnPrivileges` from importer-postgres.
 *   3. `generateScaffold` → TypeScript source.
 *   4. Either print to stdout (default) or write to `--out <path>`.
 *
 * Scaffold-only — per [ADR-0012](../../../docs/adr/0012-scaffold-only-importer.md),
 * every imported policy lands as `rawSql()` + `.todo()` so the user reviews
 * and replaces with typed predicates. The output is NOT meant to be applied
 * verbatim.
 *
 * The connection itself is the only I/O here; everything downstream
 * (`generateScaffold`) is a pure function over the rows it returns.
 */

import { writeFile } from 'node:fs/promises'

import { generateScaffold, readColumnPrivileges, readPgPolicies } from '@flowchestra/prisma-guarddog-importer-postgres'
import pc from 'picocolors'

export interface ImportOptions {
  /** Postgres connection string. Required — the importer reads `pg_policies` from a live DB. */
  readonly url: string
  /** Restrict the import to one Postgres schema (default: `public`). */
  readonly schema?: string
  /** Optional output file path. When omitted, scaffold goes to stdout. */
  readonly out?: string
  /** When true (default), writes a colored summary to stderr. */
  readonly stderr?: boolean
}

export interface ImportResult {
  readonly ok: boolean
  readonly source: string
  readonly policyRowCount: number
  readonly columnPrivilegeRowCount: number
  readonly outPath: string | undefined
  readonly diagnostics: ReadonlyArray<string>
}

export async function runImport(opts: ImportOptions): Promise<ImportResult> {
  const writeStderr = opts.stderr ?? true
  const schema = opts.schema ?? 'public'

  let pgModule
  try {
    pgModule = (await import('pg')) as typeof import('pg')
  } catch (err) {
    return failure(
      `cannot load 'pg' — install it as a peer dependency: \`pnpm add pg @types/pg\`. (${(err as Error).message})`,
      writeStderr
    )
  }

  const ClientCtor = (pgModule as unknown as { Client: typeof import('pg').Client }).Client
  const client = new ClientCtor({ connectionString: opts.url })

  try {
    await client.connect()
  } catch (err) {
    return failure(`failed to connect to ${redactUrl(opts.url)}: ${(err as Error).message}`, writeStderr)
  }

  try {
    const policies = await readPgPolicies(client, { schema })
    const columnPrivileges = await readColumnPrivileges(client, { schema })
    const source = generateScaffold({ policies, columnPrivileges })

    if (opts.out !== undefined) {
      await writeFile(opts.out, source, 'utf8')
      if (writeStderr) {
        process.stderr.write(
          `${pc.green('✓')} wrote ${pc.dim(opts.out)} ${pc.dim(`(${policies.length} policies, ${columnPrivileges.length} column grants)`)}\n` +
            `  ${pc.dim('review every rawSql() + .todo() before committing — see ADR-0012')}\n`
        )
      }
    } else {
      process.stdout.write(source)
      if (writeStderr) {
        process.stderr.write(
          `${pc.green('✓')} scaffolded ${pc.dim(`${policies.length} policies, ${columnPrivileges.length} column grants`)}\n`
        )
      }
    }

    return Object.freeze({
      ok: true,
      source,
      policyRowCount: policies.length,
      columnPrivilegeRowCount: columnPrivileges.length,
      outPath: opts.out,
      diagnostics: Object.freeze([]),
    })
  } finally {
    await client.end().catch(() => {})
  }
}

function failure(message: string, writeStderr: boolean): ImportResult {
  if (writeStderr) process.stderr.write(`${pc.red('✗')} ${message}\n`)
  return Object.freeze({
    ok: false,
    source: '',
    policyRowCount: 0,
    columnPrivilegeRowCount: 0,
    outPath: undefined,
    diagnostics: Object.freeze([message]),
  })
}

// Strip credentials from connection strings before printing — diagnostics
// land in stderr and may end up in CI logs.
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
