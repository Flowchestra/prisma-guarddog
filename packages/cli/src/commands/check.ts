/**
 * `guarddog check` — validate that the schema file loads, materializes,
 * and yields a Guarddog with at least one declaration. Intended for CI:
 * exits 0 on success, 1 on any failure with a human-readable diagnostic.
 *
 * Heavier validation (coverage across the consumer's Prisma DMMF, drift
 * against the live database, etc.) lands in the `lint` extension and the
 * `migrate --check` flow respectively. This command is the lowest-level
 * "does the schema even parse?" gate.
 */

import type { Guarddog } from '@flowchestra/prisma-guarddog-core'
import pc from 'picocolors'

import type { ResolvedConfig } from '../config.js'
import { loadSchema, SchemaLoadError } from '../load.js'

export interface CheckResult {
  readonly ok: boolean
  readonly schemaPath: string
  readonly policyCount: number
  readonly polymorphicCount: number
  readonly columnPrivilegeCount: number
  readonly noPolicyCount: number
  readonly diagnostics: ReadonlyArray<string>
}

export interface CheckOptions {
  readonly config: ResolvedConfig
  /** When true (default), writes a colored summary to stdout. */
  readonly stdout?: boolean
}

/**
 * Inspect a materialized `Guarddog` and produce a `CheckResult`. Pure
 * function — no I/O. Counts declarations and surfaces a diagnostic when
 * the Guarddog is empty.
 */
export function inspectGuard(schemaPath: string, guard: Guarddog): CheckResult {
  const policies = guard.getPolicies()
  const polymorphics = guard.getPolymorphics()
  const columnPrivileges = guard.getColumnPrivileges()
  const noPolicies = guard.getNoPolicies()

  const diagnostics: string[] = []
  const totalDeclarations = policies.length + polymorphics.length + noPolicies.length
  if (totalDeclarations === 0) {
    diagnostics.push('schema parsed but contains no policies, polymorphics, or noPolicy() declarations')
  }

  return Object.freeze({
    ok: diagnostics.length === 0,
    schemaPath,
    policyCount: policies.length,
    polymorphicCount: polymorphics.length,
    columnPrivilegeCount: columnPrivileges.length,
    noPolicyCount: noPolicies.length,
    diagnostics: Object.freeze([...diagnostics]),
  })
}

function failureResult(schemaPath: string, diagnostic: string): CheckResult {
  return Object.freeze({
    ok: false,
    schemaPath,
    policyCount: 0,
    polymorphicCount: 0,
    columnPrivilegeCount: 0,
    noPolicyCount: 0,
    diagnostics: Object.freeze([diagnostic]),
  })
}

export async function runCheck(opts: CheckOptions): Promise<CheckResult> {
  const { config } = opts
  const writeStdout = opts.stdout ?? true

  let result: CheckResult
  try {
    const loaded = await loadSchema(config.schemaPath)
    result = inspectGuard(config.schemaPath, loaded.guard)
  } catch (err) {
    result = failureResult(config.schemaPath, err instanceof SchemaLoadError ? err.message : String(err))
  }

  if (writeStdout) writeSummary(result)
  return result
}

function writeSummary(result: CheckResult): void {
  const mark = result.ok ? pc.green('✓') : pc.red('✗')
  process.stdout.write(`${mark} ${pc.dim(result.schemaPath)}\n`)
  if (result.ok) {
    process.stdout.write(
      `  ${pc.dim('policies:')} ${result.policyCount}` +
        `  ${pc.dim('polymorphics:')} ${result.polymorphicCount}` +
        `  ${pc.dim('column privileges:')} ${result.columnPrivilegeCount}` +
        `  ${pc.dim('noPolicy:')} ${result.noPolicyCount}\n`
    )
  }
  for (const diag of result.diagnostics) {
    process.stdout.write(`  ${pc.red('•')} ${diag}\n`)
  }
}
