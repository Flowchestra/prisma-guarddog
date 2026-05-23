/**
 * Coverage lint: cross-reference a `Guarddog` against the consumer's Prisma
 * model list and surface "you forgot to write a policy" gaps.
 *
 * A Prisma model is considered "covered" if any of the following is true:
 *
 *   - it has at least one `PolicyAst` (the user wrote `.model(name).policy(...)`)
 *   - it appears as the `targetModelName` of any `PolymorphicAst` target
 *   - it is the `modelName` of a `PolymorphicAst`
 *   - it has a `NoPolicyAst` declaration (an auditable opt-out, ADR — required `reason`)
 *
 * `policies(guard)`-only checks fall short of the bug class RLS itself can't
 * help with: a brand-new Prisma model with zero policies is silently
 * accessible to whichever role last had a blanket GRANT. This lint catches
 * exactly that.
 *
 * Additional warnings (not failures) flag work-in-progress:
 *
 *   - `todo-marker` — policy carries one or more `.todo(...)` markers (the
 *     scaffold importer adds these; lint reminds you to clean them up).
 *   - `raw-sql-policy` — policy uses `rawSql()` for any verb (Phase 2 plan:
 *     replace with typed predicates).
 *
 * Pure function — no I/O, no DB.
 */

import type { GuarddogLike } from '@prisma-guarddog/core'

export type LintSeverity = 'error' | 'warning'

export interface LintIssue {
  readonly severity: LintSeverity
  readonly kind: 'missing-coverage' | 'todo-marker' | 'raw-sql-policy'
  readonly modelName: string
  readonly detail: string
}

export interface LintInput {
  readonly guard: GuarddogLike
  /**
   * The Prisma model list — typically projected from `dmmf.datamodel.models`
   * by `@prisma-guarddog/importer-prisma`'s readers. Only the `name`
   * matters for coverage; `tableName` is unused here (the resolver lives
   * in core / emitters).
   */
  readonly prismaModels: ReadonlyArray<{ readonly name: string }>
}

export interface LintReport {
  readonly issues: ReadonlyArray<LintIssue>
  /** Convenience: `true` iff there is no `error`-severity issue. */
  readonly ok: boolean
}

/**
 * Run the coverage + WIP checks. Issues are returned sorted by
 * `(modelName, kind)` so output is deterministic and PR-review-friendly.
 */
export function lintCoverage(input: LintInput): LintReport {
  const issues: LintIssue[] = []
  const covered = computeCoveredModels(input.guard)

  for (const model of input.prismaModels) {
    if (!covered.has(model.name)) {
      issues.push({
        severity: 'error',
        kind: 'missing-coverage',
        modelName: model.name,
        detail: `model "${model.name}" has no .policy(), .polymorphic(), or .noPolicy() declaration`,
      })
    }
  }

  for (const policy of input.guard.getPolicies()) {
    for (const todo of policy.todos) {
      issues.push({
        severity: 'warning',
        kind: 'todo-marker',
        modelName: policy.model,
        detail: `unresolved .todo() on ${policy.model}::${policy.dbRole}: ${todo}`,
      })
    }
    for (const verb of ['select', 'insert', 'update', 'delete'] as const) {
      const spec = policy[verb]
      if (spec === undefined) continue
      if ('using' in spec && spec.using.kind === 'raw') {
        issues.push(rawSqlIssue(policy.model, policy.dbRole, verb))
      }
      if ('check' in spec && spec.check.kind === 'raw') {
        issues.push(rawSqlIssue(policy.model, policy.dbRole, verb))
      }
    }
  }

  issues.sort(compareIssues)
  const ok = issues.every((i) => i.severity !== 'error')
  return Object.freeze({ issues: Object.freeze(issues), ok })
}

function rawSqlIssue(modelName: string, dbRole: string, verb: string): LintIssue {
  return {
    severity: 'warning',
    kind: 'raw-sql-policy',
    modelName,
    detail: `${modelName}::${dbRole}.${verb} uses rawSql() — plan to replace with a typed predicate`,
  }
}

function computeCoveredModels(guard: GuarddogLike): ReadonlySet<string> {
  const covered = new Set<string>()
  for (const policy of guard.getPolicies()) covered.add(policy.model)
  for (const poly of guard.getPolymorphics()) {
    covered.add(poly.modelName)
    for (const target of poly.targets) covered.add(target.targetModelName)
  }
  for (const np of guard.getNoPolicies()) covered.add(np.model)
  return covered
}

function compareIssues(a: LintIssue, b: LintIssue): number {
  const m = a.modelName.localeCompare(b.modelName)
  if (m !== 0) return m
  const s = severityOrder(a.severity) - severityOrder(b.severity)
  if (s !== 0) return s
  return a.kind.localeCompare(b.kind)
}

function severityOrder(s: LintSeverity): number {
  return s === 'error' ? 0 : 1
}
