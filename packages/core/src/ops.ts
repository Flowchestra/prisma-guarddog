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
import type { FunctionLanguage, FunctionParallel, FunctionSecurity, FunctionVolatility } from './function-defs.js'

/** Subset of verbs that have column-level granularity (no DELETE). */
export type ColumnVerb = 'select' | 'insert' | 'update'

/**
 * One resolved function argument. Defaults applied (no `undefined` enum
 * fields) so the record is the single source of truth for emission + diffing.
 */
export interface FunctionArgRecord {
  readonly name: string
  readonly type: string
  readonly default: string | undefined
}

/**
 * Snapshot of one guarddog-managed SQL function (ADR-0026), keyed in
 * {@link State} by {@link functionKey}(schema, name). Carries the fully
 * resolved definition (defaults applied) plus a normalized `signature` string
 * the diff engine uses to decide DROP+CREATE (signature change) vs
 * CREATE OR REPLACE (body / attribute change only). EXECUTE grants are
 * tracked separately as {@link ColumnGrantRecord}-style records.
 */
export interface FunctionOpRecord {
  readonly schema: string
  readonly name: string
  readonly args: ReadonlyArray<FunctionArgRecord>
  readonly returns: string
  readonly language: FunctionLanguage
  readonly volatility: FunctionVolatility
  readonly parallel: FunctionParallel
  readonly security: FunctionSecurity
  readonly searchPath: ReadonlyArray<string>
  readonly body: string
  /**
   * `schema.name(argType, ...) -> returns` — the parts Postgres won't let
   * `CREATE OR REPLACE` change. A difference here forces DROP+CREATE.
   */
  readonly signature: string
}

export interface FunctionGrantRecord {
  readonly schema: string
  readonly name: string
  readonly role: string
  /**
   * The function's argument types, in order — Postgres identifies a function
   * by its full signature, so `GRANT EXECUTE ON FUNCTION` needs them. Carried
   * on the record (rather than looked up from {@link State.functions}) so the
   * renderer can emit from the op alone.
   */
  readonly argTypes: ReadonlyArray<string>
}

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
  | { readonly kind: 'create-schema'; readonly schema: string }
  | { readonly kind: 'create-function'; readonly fn: FunctionOpRecord }
  | {
      readonly kind: 'drop-function'
      readonly schema: string
      readonly name: string
      readonly argTypes: ReadonlyArray<string>
    }
  | {
      readonly kind: 'grant-execute'
      readonly schema: string
      readonly name: string
      readonly role: string
      readonly argTypes: ReadonlyArray<string>
    }
  | {
      readonly kind: 'revoke-execute'
      readonly schema: string
      readonly name: string
      readonly role: string
      readonly argTypes: ReadonlyArray<string>
    }

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
  /** Function schemas guarddog ensures exist (`CREATE SCHEMA IF NOT EXISTS`). */
  readonly schemas: ReadonlySet<string>
  /** Keyed by {@link functionKey}(schema, name). */
  readonly functions: ReadonlyMap<string, FunctionOpRecord>
  /** Keyed by {@link functionGrantKey}(schema, name, role). */
  readonly functionGrants: ReadonlyMap<string, FunctionGrantRecord>
}

interface MutableState {
  rlsEnabled: Set<string>
  rlsForced: Set<string>
  policies: Map<string, PolicyOpRecord>
  columnGrants: Map<string, ColumnGrantRecord>
  roles: Map<string, RoleRecord>
  roleMemberships: Map<string, RoleMembershipRecord>
  schemas: Set<string>
  functions: Map<string, FunctionOpRecord>
  functionGrants: Map<string, FunctionGrantRecord>
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
    schemas: new Set(),
    functions: new Map(),
    functionGrants: new Map(),
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
    schemas: new Set(state.schemas),
    functions: new Map(state.functions),
    functionGrants: new Map(state.functionGrants),
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
    case 'create-schema':
      s.schemas.add(op.schema)
      return
    case 'create-function':
      s.functions.set(functionKey(op.fn.schema, op.fn.name), op.fn)
      return
    case 'drop-function':
      s.functions.delete(functionKey(op.schema, op.name))
      return
    case 'grant-execute':
      s.functionGrants.set(
        functionGrantKey(op.schema, op.name, op.role),
        Object.freeze({ schema: op.schema, name: op.name, role: op.role, argTypes: op.argTypes })
      )
      return
    case 'revoke-execute':
      s.functionGrants.delete(functionGrantKey(op.schema, op.name, op.role))
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

/** Key used for {@link State.functions}. */
export function functionKey(schema: string, name: string): string {
  return `${schema}.${name}`
}

/** Key used for {@link State.functionGrants}. */
export function functionGrantKey(schema: string, name: string, role: string): string {
  return `${schema}.${name}::EXECUTE::${role}`
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
    schemas: s.schemas,
    functions: s.functions,
    functionGrants: s.functionGrants,
  })
}
