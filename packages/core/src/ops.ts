/**
 * Op union, State, and `applyOps` reducer.
 *
 * Ops are the canonical interchange format between the compile step
 * (`compileToOps(guard)`) and the migration writer / emitters. They are
 * intent-level — `create-policy` carries the `Expr` tree, not the rendered
 * SQL — so sidecar JSON captures author intent and the emitter renders
 * dialect-specific DDL at migration-write time.
 *
 * Forward-replay (`applyOps(empty(), allOpsAcrossAllSidecars)`) reconstructs
 * the current declared state without ever talking to Postgres. The diff
 * engine (`diffStates`) then compares two states to produce a minimal Op
 * sequence transforming one into the other.
 */

import type { Expr, Verb } from './ast.js'

/** Subset of verbs that have column-level granularity (no DELETE). */
export type ColumnVerb = 'select' | 'insert' | 'update'

/**
 * Snapshot of one declared policy, keyed in {@link State} by `${table}::${name}`.
 * The `discriminator` field is set for polymorphic-target policies — at
 * compile time the discriminator equality is already fused into the `using`
 * / `check` expressions, so this is provenance metadata, not something the
 * emitter has to re-derive.
 */
export interface PolicyOpRecord {
  readonly name: string
  readonly model: string
  readonly table: string
  readonly dbRole: string
  readonly verb: Verb
  readonly using: Expr | undefined
  readonly check: Expr | undefined
  readonly todos: ReadonlyArray<string>
  readonly discriminator: { readonly column: string; readonly value: string } | undefined
}

export interface RoleRecord {
  readonly bypassesRls: boolean
  readonly nologin: boolean
}

export interface ColumnGrantRecord {
  readonly table: string
  readonly column: string
  readonly verb: ColumnVerb
  readonly role: string
}

export interface RoleMembershipRecord {
  readonly parent: string
  readonly child: string
}

export type Op =
  | { readonly kind: 'enable-rls'; readonly table: string }
  | { readonly kind: 'disable-rls'; readonly table: string }
  | { readonly kind: 'force-rls'; readonly table: string }
  | { readonly kind: 'unforce-rls'; readonly table: string }
  | { readonly kind: 'create-policy'; readonly policy: PolicyOpRecord }
  | { readonly kind: 'drop-policy'; readonly table: string; readonly name: string }
  | {
      readonly kind: 'grant-column'
      readonly table: string
      readonly column: string
      readonly verb: ColumnVerb
      readonly role: string
    }
  | {
      readonly kind: 'revoke-column'
      readonly table: string
      readonly column: string
      readonly verb: ColumnVerb
      readonly role: string
    }
  | { readonly kind: 'create-role'; readonly name: string; readonly bypassesRls: boolean; readonly nologin: boolean }
  | { readonly kind: 'drop-role'; readonly name: string }
  | { readonly kind: 'grant-role-membership'; readonly parent: string; readonly child: string }
  | { readonly kind: 'revoke-role-membership'; readonly parent: string; readonly child: string }

/**
 * Declared-state snapshot. Forward-replay friendly: `applyOps(empty(), ops)`
 * reconstructs the same state regardless of how the ops were batched across
 * sidecars, as long as their relative order is preserved.
 */
export interface State {
  readonly rlsEnabled: ReadonlySet<string>
  readonly rlsForced: ReadonlySet<string>
  /** Keyed by {@link policyMapKey}(table, policyName). */
  readonly policies: ReadonlyMap<string, PolicyOpRecord>
  /** Keyed by {@link columnGrantKey}(table, column, verb, role). */
  readonly columnGrants: ReadonlyMap<string, ColumnGrantRecord>
  readonly roles: ReadonlyMap<string, RoleRecord>
  /** Keyed by {@link roleMembershipKey}(parent, child). */
  readonly roleMemberships: ReadonlyMap<string, RoleMembershipRecord>
}

interface MutableState {
  rlsEnabled: Set<string>
  rlsForced: Set<string>
  policies: Map<string, PolicyOpRecord>
  columnGrants: Map<string, ColumnGrantRecord>
  roles: Map<string, RoleRecord>
  roleMemberships: Map<string, RoleMembershipRecord>
}

/** Empty starting point for forward-replay. */
export function empty(): State {
  return freezeState({
    rlsEnabled: new Set(),
    rlsForced: new Set(),
    policies: new Map(),
    columnGrants: new Map(),
    roles: new Map(),
    roleMemberships: new Map(),
  })
}

/**
 * Forward-replay a sequence of ops against a starting state. Pure — does
 * not mutate the input. Returns a new frozen state.
 */
export function applyOps(state: State, ops: ReadonlyArray<Op>): State {
  const next: MutableState = {
    rlsEnabled: new Set(state.rlsEnabled),
    rlsForced: new Set(state.rlsForced),
    policies: new Map(state.policies),
    columnGrants: new Map(state.columnGrants),
    roles: new Map(state.roles),
    roleMemberships: new Map(state.roleMemberships),
  }
  for (const op of ops) applyOp(next, op)
  return freezeState(next)
}

function applyOp(s: MutableState, op: Op): void {
  switch (op.kind) {
    case 'enable-rls':
      s.rlsEnabled.add(op.table)
      return
    case 'disable-rls':
      s.rlsEnabled.delete(op.table)
      return
    case 'force-rls':
      s.rlsForced.add(op.table)
      return
    case 'unforce-rls':
      s.rlsForced.delete(op.table)
      return
    case 'create-policy':
      s.policies.set(policyMapKey(op.policy.table, op.policy.name), op.policy)
      return
    case 'drop-policy':
      s.policies.delete(policyMapKey(op.table, op.name))
      return
    case 'grant-column':
      s.columnGrants.set(
        columnGrantKey(op.table, op.column, op.verb, op.role),
        Object.freeze({ table: op.table, column: op.column, verb: op.verb, role: op.role })
      )
      return
    case 'revoke-column':
      s.columnGrants.delete(columnGrantKey(op.table, op.column, op.verb, op.role))
      return
    case 'create-role':
      s.roles.set(op.name, Object.freeze({ bypassesRls: op.bypassesRls, nologin: op.nologin }))
      return
    case 'drop-role':
      s.roles.delete(op.name)
      return
    case 'grant-role-membership':
      s.roleMemberships.set(
        roleMembershipKey(op.parent, op.child),
        Object.freeze({ parent: op.parent, child: op.child })
      )
      return
    case 'revoke-role-membership':
      s.roleMemberships.delete(roleMembershipKey(op.parent, op.child))
      return
  }
}

/** Key used for {@link State.policies}. */
export function policyMapKey(table: string, name: string): string {
  return `${table}::${name}`
}

/** Key used for {@link State.columnGrants}. */
export function columnGrantKey(table: string, column: string, verb: ColumnVerb, role: string): string {
  return `${table}.${column}::${verb}::${role}`
}

/** Key used for {@link State.roleMemberships}. */
export function roleMembershipKey(parent: string, child: string): string {
  return `${parent}->${child}`
}

function freezeState(s: MutableState): State {
  // Set / Map are not deeply immutable via Object.freeze, but the
  // ReadonlySet / ReadonlyMap typing protects consumers at compile time.
  // What actually protects earlier snapshots from later mutation is the
  // defensive copy inside applyOps.
  return Object.freeze({
    rlsEnabled: s.rlsEnabled,
    rlsForced: s.rlsForced,
    policies: s.policies,
    columnGrants: s.columnGrants,
    roles: s.roles,
    roleMemberships: s.roleMemberships,
  })
}
