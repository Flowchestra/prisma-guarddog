/**
 * `@flowchestra/prisma-guarddog-lint` — coverage check.
 *
 * `lintCoverage` cross-references a Guarddog instance against the consumer's
 * Prisma model list and reports missing policies plus work-in-progress
 * markers (todos and rawSql() uses).
 *
 * Catches the bug class RLS itself can't help with: a Prisma model with
 * zero policies is silently accessible to whichever role last had a
 * blanket GRANT. The CLI can fold this in as `guarddog check --lint` and
 * editor extensions surface issues inline; both paths call the same
 * pure-function core.
 */

export { lintCoverage } from './coverage.js'
export type { LintInput, LintIssue, LintReport, LintSeverity } from './coverage.js'
