/**
 * Policy drift detection (ADR-0029).
 *
 * Compares guarddog's declared `State` (from `compileToState`) against the
 * live policy inventory read from Postgres (`readPolicyInventory`) and
 * classifies, scoped to the tables guarddog manages (the ones it enables RLS
 * on):
 *
 *   - `foreign`      — a live policy on a managed table that guarddog neither
 *     declares nor marked as its own. Permissive ones OR with guarddog's
 *     policies and can WIDEN access — the silent adoption hazard.
 *   - `staleManaged` — a guarddog-marked live policy guarddog no longer
 *     declares (a prior-run orphan; safe for guarddog to drop).
 *   - `missing`      — a policy guarddog declares that isn't in the live DB
 *     (not applied yet, or drifted away).
 *
 * Pure function — no I/O. The CLI reads the inventory and renders the report.
 */

import type { Op, State } from '@flowchestra/prisma-guarddog-core'
import { quoteIdent, quoteString } from '@flowchestra/prisma-guarddog-emitter-postgres-rls'
import type { ImportedPolicyRow, PolicyInventoryRow } from '@flowchestra/prisma-guarddog-importer-postgres'

import { GUARDDOG_IGNORE_COMMENT, GUARDDOG_POLICY_COMMENT } from './render-ops.js'

export interface ForeignPolicy {
  readonly table: string
  readonly policyName: string
  readonly command: PolicyInventoryRow['command']
  /** Permissive policies OR with guarddog's → an access-widening risk. */
  readonly permissive: boolean
}

export interface StaleManagedPolicy {
  readonly table: string
  readonly policyName: string
}

export interface MissingPolicy {
  readonly table: string
  readonly policyName: string
}

export interface AcknowledgedPolicy {
  readonly table: string
  readonly policyName: string
}

export interface PolicyDrift {
  /** Tables guarddog manages (enables RLS on) — the scope of foreign detection. */
  readonly managedTables: ReadonlyArray<string>
  readonly foreign: ReadonlyArray<ForeignPolicy>
  readonly staleManaged: ReadonlyArray<StaleManagedPolicy>
  readonly missing: ReadonlyArray<MissingPolicy>
  /**
   * Foreign policies the operator deliberately kept (`guarddog adopt` → keep,
   * marked `:ignore`). Reported for transparency; not drift (ADR-0030).
   */
  readonly acknowledged: ReadonlyArray<AcknowledgedPolicy>
  /** True iff there is no foreign / stale / missing drift (acknowledged doesn't count). */
  readonly ok: boolean
}

/**
 * Compute drift between guarddog's declared state and the live policy
 * inventory. `live` is expected to already be schema-scoped by the caller
 * (`readPolicyInventory`).
 */
export function computePolicyDrift(declared: State, live: ReadonlyArray<PolicyInventoryRow>): PolicyDrift {
  const managedTables = new Set(declared.rlsEnabled)

  // Declared policy names grouped by table.
  const declaredByTable = new Map<string, Set<string>>()
  for (const rec of declared.policies.values()) {
    let names = declaredByTable.get(rec.table)
    if (names === undefined) {
      names = new Set<string>()
      declaredByTable.set(rec.table, names)
    }
    names.add(rec.name)
  }

  // Index of live policies for the `missing` check.
  const liveByKey = new Set(live.map((p) => `${p.table}::${p.policyName}`))

  const foreign: ForeignPolicy[] = []
  const staleManaged: StaleManagedPolicy[] = []
  const acknowledged: AcknowledgedPolicy[] = []
  for (const row of live) {
    if (!managedTables.has(row.table)) continue
    if (declaredByTable.get(row.table)?.has(row.policyName)) continue // declared + owned
    if (row.comment === GUARDDOG_POLICY_COMMENT) {
      staleManaged.push(Object.freeze({ table: row.table, policyName: row.policyName }))
    } else if (row.comment === GUARDDOG_IGNORE_COMMENT) {
      acknowledged.push(Object.freeze({ table: row.table, policyName: row.policyName }))
    } else {
      foreign.push(
        Object.freeze({
          table: row.table,
          policyName: row.policyName,
          command: row.command,
          permissive: row.permissive,
        })
      )
    }
  }

  const missing: MissingPolicy[] = []
  for (const rec of declared.policies.values()) {
    if (!liveByKey.has(`${rec.table}::${rec.name}`)) {
      missing.push(Object.freeze({ table: rec.table, policyName: rec.name }))
    }
  }

  const sortByTableName = <T extends { table: string; policyName: string }>(a: T, b: T): number =>
    a.table.localeCompare(b.table) || a.policyName.localeCompare(b.policyName)

  return Object.freeze({
    managedTables: Object.freeze([...managedTables].toSorted()),
    foreign: Object.freeze(foreign.toSorted(sortByTableName)),
    staleManaged: Object.freeze(staleManaged.toSorted(sortByTableName)),
    missing: Object.freeze(missing.toSorted(sortByTableName)),
    acknowledged: Object.freeze(acknowledged.toSorted(sortByTableName)),
    ok: foreign.length === 0 && staleManaged.length === 0 && missing.length === 0,
  })
}

/** SQL stamping a foreign policy as deliberately kept (`:ignore`, ADR-0030). */
export function ignoreCommentSql(table: string, policyName: string): string {
  return `COMMENT ON POLICY ${quoteIdent(policyName)} ON ${quoteIdent(table)} IS ${quoteString(GUARDDOG_IGNORE_COMMENT)};`
}

/** Per-policy adoption disposition (`guarddog adopt`, ADR-0030). */
export type AdoptionDisposition = 'keep' | 'remove' | 'edit' | 'override' | 'skip'

export interface AdoptionPlan {
  /** keep → stamp the `:ignore` marker. */
  readonly keep: ReadonlyArray<AcknowledgedPolicy>
  /** remove → DROP POLICY now. */
  readonly dropOps: ReadonlyArray<Op>
  /** edit → scaffold rawSql(<legacy>) + .todo() (the full row carries the SQL). */
  readonly editRows: ReadonlyArray<ImportedPolicyRow>
  /** override → scaffold a fresh-author .todo() stub (legacy SQL discarded). */
  readonly overrides: ReadonlyArray<{ readonly table: string; readonly policyName: string; readonly command: string }>
  /** skip → left untouched; re-surfaces next run. */
  readonly skipped: ReadonlyArray<AcknowledgedPolicy>
}

/**
 * Map per-policy dispositions to their effects (ADR-0030). Pure — the
 * interactive prompt builds `dispositions`; this turns them into the
 * keep-comments / drop ops / scaffold inputs the command applies.
 *
 * `rowsByKey` is keyed `${table}::${policyName}` (from `readPgPolicies`) and
 * supplies the legacy SQL needed to scaffold an `edit`. Unknown disposition or
 * a missing row falls back to `skip`.
 */
export function planAdoption(
  foreign: ReadonlyArray<ForeignPolicy>,
  rowsByKey: ReadonlyMap<string, ImportedPolicyRow>,
  dispositions: ReadonlyMap<string, AdoptionDisposition>
): AdoptionPlan {
  const keep: AcknowledgedPolicy[] = []
  const dropOps: Op[] = []
  const editRows: ImportedPolicyRow[] = []
  const overrides: Array<{ table: string; policyName: string; command: string }> = []
  const skipped: AcknowledgedPolicy[] = []

  for (const f of foreign) {
    const key = `${f.table}::${f.policyName}`
    const disposition = dispositions.get(key) ?? 'skip'
    const ref = { table: f.table, policyName: f.policyName }
    switch (disposition) {
      case 'keep':
        keep.push(Object.freeze(ref))
        break
      case 'remove':
        dropOps.push({ kind: 'drop-policy', table: f.table, name: f.policyName })
        break
      case 'edit': {
        const row = rowsByKey.get(key)
        if (row !== undefined) editRows.push(row)
        else skipped.push(Object.freeze(ref))
        break
      }
      case 'override':
        overrides.push(Object.freeze({ table: f.table, policyName: f.policyName, command: f.command }))
        break
      case 'skip':
        skipped.push(Object.freeze(ref))
        break
    }
  }

  return Object.freeze({
    keep: Object.freeze(keep),
    dropOps: Object.freeze(dropOps),
    editRows: Object.freeze(editRows),
    overrides: Object.freeze(overrides),
    skipped: Object.freeze(skipped),
  })
}

/**
 * The `drop-policy` ops that a `--drop-unmanaged` cutover should emit: every
 * foreign and stale-managed policy on a managed table. Foreign policies are a
 * consumer's own — dropping them is deliberate (opt-in), so this is never on
 * the default path. Ordered deterministically.
 */
export function driftToDropOps(drift: PolicyDrift): ReadonlyArray<Op> {
  const targets = [
    ...drift.foreign.map((p) => ({ table: p.table, name: p.policyName })),
    ...drift.staleManaged.map((p) => ({ table: p.table, name: p.policyName })),
  ].toSorted((a, b) => a.table.localeCompare(b.table) || a.name.localeCompare(b.name))

  return Object.freeze(targets.map((t): Op => ({ kind: 'drop-policy', table: t.table, name: t.name })))
}
