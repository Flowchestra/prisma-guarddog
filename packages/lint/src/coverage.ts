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
 * Additional warnings (not failures) flag work-in-progress and a known
 * enforcement gap:
 *
 *   - `todo-marker` — policy carries one or more `.todo(...)` markers (the
 *     scaffold importer adds these; lint reminds you to clean them up).
 *   - `raw-sql-policy` — policy uses `rawSql()` for any verb (Phase 2 plan:
 *     replace with typed predicates).
 *   - `column-privilege-unenforced` — model declares `.columnPrivileges()`,
 *     but guarddog emits only the column-level GRANTs, not the base-table
 *     REVOKE prelude needed to enforce them (issue #2). A column-level GRANT
 *     does not restrict access on its own: any table-level `GRANT` (or a
 *     PUBLIC default) supersedes it. Until guarddog manages base-table
 *     privileges (tracked for a future release), the consumer must withhold
 *     table-level privileges and grant only the allowed columns. This warning
 *     stops that gap from failing silently.
 *   - `policy-uses-declared-name` — a verb spec carries a user-declared `name`
 *     (`.named(...)` / per-verb `{ name }`, ADR-0031). Opt-in escape hatch for
 *     transitional adoption only — once the cutover is complete, drop the
 *     override and converge on the auto-gen `<table>_<role>_<command>`. The
 *     warning carries the auto-gen target so authors see the canonical name.
 *
 * Pure function — no I/O, no DB.
 */

import {
  defaultTableResolver,
  type GuarddogLike,
  policyName,
  type SelectSpec,
  type Verb,
} from '@flowchestra/prisma-guarddog-core'

export type LintSeverity = 'error' | 'warning'

export interface LintIssue {
  readonly severity: LintSeverity
  readonly kind:
    | 'missing-coverage'
    | 'todo-marker'
    | 'raw-sql-policy'
    | 'column-privilege-unenforced'
    | 'policy-uses-declared-name'
  readonly modelName: string
  readonly detail: string
}

export interface LintInput {
  readonly guard: GuarddogLike
  /**
   * The Prisma model list — typically projected from `dmmf.datamodel.models`
   * by `@flowchestra/prisma-guarddog-importer-prisma`'s readers. Only the `name`
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

  for (const cp of input.guard.getColumnPrivileges()) {
    const cols = Object.keys(cp.columns).toSorted().join(', ')
    issues.push({
      severity: 'warning',
      kind: 'column-privilege-unenforced',
      modelName: cp.model,
      detail:
        `model "${cp.model}" declares columnPrivileges (${cols}) but guarddog emits only the column-level GRANTs, ` +
        'not a base-table REVOKE prelude — a column GRANT does not restrict access on its own, so any table-level ' +
        'GRANT or PUBLIC default supersedes it. Withhold table-level privileges and grant only the allowed columns ' +
        'until guarddog manages base-table grants (issue #2).',
    })
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
    const table = policy.table ?? defaultTableResolver(policy.model)
    for (const verb of ['select', 'insert', 'update', 'delete'] as const) {
      const spec = policy[verb]
      if (spec === undefined) continue
      if ('using' in spec && spec.using.kind === 'raw') {
        issues.push(rawSqlIssue(policy.model, policy.dbRole, verb))
      }
      if ('check' in spec && spec.check.kind === 'raw') {
        issues.push(rawSqlIssue(policy.model, policy.dbRole, verb))
      }
      const declaredName = (spec as SelectSpec).name
      if (declaredName !== undefined) {
        issues.push(declaredNameIssue(policy.model, policy.dbRole, verb, declaredName, table))
      }
    }
  }

  for (const poly of input.guard.getPolymorphics()) {
    const polyTable = poly.table ?? defaultTableResolver(poly.modelName)
    for (const target of poly.targets) {
      for (const tp of target.policies) {
        for (const verb of ['select', 'insert', 'update', 'delete'] as const) {
          const spec = tp[verb]
          if (spec === undefined) continue
          const declaredName = (spec as SelectSpec).name
          if (declaredName !== undefined) {
            issues.push(
              declaredNameIssue(poly.modelName, tp.dbRole, verb, declaredName, polyTable, target.discriminatorValue)
            )
          }
        }
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

/**
 * Warning for ADR-0031's `.named()` / per-verb `{ name }`. Opt-in escape
 * hatch for transitional adoption — surfaces the auto-gen target so authors
 * see the canonical name they should converge on once the cutover is done.
 */
function declaredNameIssue(
  modelName: string,
  dbRole: string,
  verb: Verb,
  declaredName: string,
  table: string,
  discriminatorValue?: string
): LintIssue {
  const autoName = policyName(
    discriminatorValue !== undefined ? { table, dbRole, verb, discriminatorValue } : { table, dbRole, verb }
  )
  const same = declaredName === autoName
  const detail =
    `${modelName}::${dbRole}.${verb} declares policy name "${declaredName}"` +
    (same
      ? ' — this matches the auto-generated name; drop the override to converge on the convention.'
      : ` — transitional only (ADR-0031); converge on the auto-generated name "${autoName}" once adoption is complete.`)
  return { severity: 'warning', kind: 'policy-uses-declared-name', modelName, detail }
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
