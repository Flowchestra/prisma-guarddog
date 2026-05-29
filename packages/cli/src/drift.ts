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
import type { PolicyInventoryRow } from '@flowchestra/prisma-guarddog-importer-postgres'

import { GUARDDOG_POLICY_COMMENT } from './render-ops.js'

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

export interface PolicyDrift {
  /** Tables guarddog manages (enables RLS on) — the scope of foreign detection. */
  readonly managedTables: ReadonlyArray<string>
  readonly foreign: ReadonlyArray<ForeignPolicy>
  readonly staleManaged: ReadonlyArray<StaleManagedPolicy>
  readonly missing: ReadonlyArray<MissingPolicy>
  /** True iff there is no foreign / stale / missing drift. */
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
  for (const row of live) {
    if (!managedTables.has(row.table)) continue
    if (declaredByTable.get(row.table)?.has(row.policyName)) continue // declared + owned
    if (row.comment === GUARDDOG_POLICY_COMMENT) {
      staleManaged.push(Object.freeze({ table: row.table, policyName: row.policyName }))
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
    ok: foreign.length === 0 && staleManaged.length === 0 && missing.length === 0,
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
