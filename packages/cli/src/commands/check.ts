/**
 * `guarddog check` — validate that the schema file loads, materializes,
 * and yields a Guarddog with at least one declaration. Intended for CI:
 * exits 0 on success, 1 on any failure with a human-readable diagnostic.
 *
 * Pass `--lint` to also cross-reference the loaded Guarddog against the
 * consumer's Prisma DMMF and fail on any model that has no `.policy()`,
 * `.polymorphic()`, or `.noPolicy()` coverage. This is the canonical way
 * to surface the bug class RLS itself can't catch: a new Prisma model
 * silently inheriting a blanket GRANT because nobody wrote a policy.
 *
 * Drift detection against the live database lives in `guarddog diff`.
 * This command is the schema-side gate.
 */

import type { Guarddog } from '@flowchestra/prisma-guarddog-core'
import { readPrismaModels } from '@flowchestra/prisma-guarddog-importer-prisma'
import { type LintIssue, lintCoverage } from '@flowchestra/prisma-guarddog-lint'
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
  /** Lint issues, present only when `--lint` was requested. */
  readonly lintIssues: ReadonlyArray<LintIssue> | undefined
}

export interface CheckOptions {
  readonly config: ResolvedConfig
  /** When true (default), writes a colored summary to stdout. */
  readonly stdout?: boolean
  /** When true, also runs coverage lint against the Prisma DMMF. */
  readonly lint?: boolean
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
    lintIssues: undefined,
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
    lintIssues: undefined,
  })
}

export async function runCheck(opts: CheckOptions): Promise<CheckResult> {
  const { config } = opts
  const writeStdout = opts.stdout ?? true

  let result: CheckResult
  try {
    const loaded = await loadSchema(config.schemaPath)
    result = inspectGuard(config.schemaPath, loaded.guard)

    if (opts.lint === true && result.ok) {
      result = await runLint(result, config, loaded.guard)
    }
  } catch (err) {
    result = failureResult(config.schemaPath, err instanceof SchemaLoadError ? err.message : String(err))
  }

  if (writeStdout) writeSummary(result)
  return result
}

async function runLint(base: CheckResult, config: ResolvedConfig, guard: Guarddog): Promise<CheckResult> {
  let prismaModels
  try {
    prismaModels = await readPrismaModels(config.prismaSchemaPath)
  } catch (err) {
    return Object.freeze({
      ...base,
      ok: false,
      diagnostics: Object.freeze([
        ...base.diagnostics,
        `coverage lint: failed to read Prisma schema at ${config.prismaSchemaPath}: ${(err as Error).message}`,
      ]),
      lintIssues: undefined,
    })
  }

  const report = lintCoverage({ guard, prismaModels })
  const errorIssues = report.issues.filter((i) => i.severity === 'error')
  const nextDiagnostics = errorIssues.map((i) => `coverage lint [${i.kind}] ${i.modelName}: ${i.detail}`)

  return Object.freeze({
    ...base,
    ok: errorIssues.length === 0,
    diagnostics: Object.freeze([...base.diagnostics, ...nextDiagnostics]),
    lintIssues: report.issues,
  })
}

function writeSummary(result: CheckResult): void {
  const mark = result.ok ? pc.green('✓') : pc.red('✗')
  process.stdout.write(`${mark} ${pc.dim(result.schemaPath)}\n`)
  if (result.policyCount + result.polymorphicCount + result.noPolicyCount > 0) {
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
  if (result.lintIssues !== undefined) {
    const warnings = result.lintIssues.filter((i) => i.severity === 'warning')
    for (const warn of warnings) {
      process.stdout.write(`  ${pc.yellow('•')} [${warn.kind}] ${warn.modelName}: ${warn.detail}\n`)
    }
    if (result.ok && warnings.length === 0) {
      process.stdout.write(`  ${pc.dim('lint: 0 issues')}\n`)
    }
  }
}
