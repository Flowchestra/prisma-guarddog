/**
 * Lifecycle: compile a `Guarddog` instance into a target Op sequence, and
 * diff a current State against a target State to produce the minimal Op
 * sequence that transforms one into the other.
 *
 *     const target = applyOps(empty(), compileToOps(guard))
 *     const current = applyOps(empty(), allHistoricalOps)   // forward-replay sidecars
 *     const ops = diffStates(current, target)
 *
 * The CLI `migrate` command uses this pipeline: forward-replay every
 * `guarddog.json` sidecar found in `prisma/migrations/` to derive `current`,
 * compile the user's schema to derive `target`, and write the resulting
 * diff out as a new timestamped migration plus its own sidecar.
 *
 * Compilation is deterministic: roles in `Object.keys` order, policies
 * sorted by (table, dbRole, verb), polymorphic targets sorted by
 * discriminator value, and column grants sorted by (table, column, verb,
 * role). Two runs against the same schema produce byte-identical Op
 * sequences — important for migration-file determinism and PR review.
 */

import type {
  ColumnPrivilegeAst,
  ColumnPrivilegeGrant,
  Expr,
  NoPolicyAst,
  PolicyAst,
  PolymorphicAst,
  PolymorphicTargetAst,
  PolymorphicTargetPolicyAst,
  Verb,
} from './ast.js'
import type { DbRolesDefinition } from './db-roles.js'
import { defaultTableResolver, policyName } from './naming.js'
import {
  applyOps,
  type ColumnGrantRecord,
  type ColumnVerb,
  empty,
  type Op,
  type PolicyOpRecord,
  type RoleMembershipRecord,
  type RoleRecord,
  type State,
} from './ops.js'

export interface CompileOptions {
  /**
   * Resolve a Prisma model name to a Postgres table name. Falls back to
   * `defaultTableResolver` (lower-snake_case). Per-model overrides via
   * `ModelBuilder.table()` always win and bypass this resolver.
   */
  readonly resolveTable?: (modelName: string) => string
}

/**
 * Structural view of the `Guarddog` surface that `compileToOps` actually
 * touches. Typed as an interface (instead of `Guarddog<...>` directly) so
 * the function accepts any concrete `Guarddog` specialization regardless
 * of generic variance.
 */
export interface GuarddogLike {
  readonly config: { readonly dbRoles: DbRolesDefinition }
  getPolicies(): readonly PolicyAst[]
  getPolymorphics(): readonly PolymorphicAst[]
  getColumnPrivileges(): readonly ColumnPrivilegeAst[]
  getNoPolicies(): readonly NoPolicyAst[]
}

/** Used by lint/coverage to distinguish "covered" models from gaps. */
export interface CoverageSummary {
  readonly policies: ReadonlyArray<PolicyAst>
  readonly polymorphics: ReadonlyArray<PolymorphicAst>
  readonly columnPrivileges: ReadonlyArray<ColumnPrivilegeAst>
  readonly noPolicies: ReadonlyArray<NoPolicyAst>
}

/**
 * Walk a Guarddog instance and produce its target Op sequence. The
 * returned list is suitable for `applyOps(empty(), ops)` to yield the
 * target {@link State}.
 */
export function compileToOps(guard: GuarddogLike, opts: CompileOptions = {}): readonly Op[] {
  const resolveTable = opts.resolveTable ?? defaultTableResolver

  const roleOps: Op[] = []
  const policyOps: Op[] = []
  const columnGrantOps: Op[] = []
  const rlsTables = new Set<string>()

  appendRoleOps(roleOps, guard)
  appendPolicyOps(policyOps, guard, resolveTable, rlsTables)
  appendPolymorphicOps(policyOps, guard, resolveTable, rlsTables)
  appendColumnPrivilegeOps(columnGrantOps, guard, resolveTable)

  const rlsOps: Op[] = []
  appendRlsOps(rlsOps, rlsTables)

  return Object.freeze([...roleOps, ...rlsOps, ...policyOps, ...columnGrantOps])
}

/**
 * `applyOps(empty(), compileToOps(guard))` — convenience for the common
 * "what does this Guarddog declare?" question.
 */
export function compileToState(guard: GuarddogLike, opts: CompileOptions = {}): State {
  return applyOps(empty(), compileToOps(guard, opts))
}

/**
 * Produce the minimal Op sequence transforming `current` into `target`.
 * Op ordering is engineered for safe replay:
 *
 *   1. drop policies (before disable-rls, before drop-role)
 *   2. revoke column grants
 *   3. revoke role memberships
 *   4. unforce / disable RLS for tables no longer policied
 *   5. drop roles (after all dependents are gone)
 *   6. create roles
 *   7. grant role memberships
 *   8. enable / force RLS for newly-policied tables
 *   9. create policies
 *  10. grant column grants
 *
 * Drop-then-recreate semantics for policy mutations (Postgres
 * `ALTER POLICY` only supports a subset of changes; we always emit a clean
 * pair instead, matching the idempotency pattern the emitter uses).
 */
export function diffStates(current: State, target: State): readonly Op[] {
  // Drop phase: tear down dependents before their dependencies.
  const dropPolicies: Op[] = []
  const dropColumnGrants: Op[] = []
  const dropMemberships: Op[] = []
  const rlsRemovals: Op[] = []
  const dropRoles: Op[] = []

  // Add phase: bring dependencies up before dependents.
  const addRoles: Op[] = []
  const addMemberships: Op[] = []
  const rlsAdds: Op[] = []
  const addPolicies: Op[] = []
  const addColumnGrants: Op[] = []

  diffPolicies(current, target, dropPolicies, addPolicies)
  diffColumnGrants(current, target, dropColumnGrants, addColumnGrants)
  diffRoleMemberships(current, target, dropMemberships)
  diffRoleMembershipAdds(current, target, addMemberships)
  diffRlsRemovals(current, target, rlsRemovals)
  diffRlsAdds(current, target, rlsAdds)
  diffRoles(current, target, dropRoles, addRoles)

  return Object.freeze([
    ...dropPolicies,
    ...dropColumnGrants,
    ...dropMemberships,
    ...rlsRemovals,
    ...dropRoles,
    ...addRoles,
    ...addMemberships,
    ...rlsAdds,
    ...addPolicies,
    ...addColumnGrants,
  ])
}

// --------------------------------------------------------------------------
// compileToOps internals
// --------------------------------------------------------------------------

function appendRoleOps(out: Op[], guard: GuarddogLike): void {
  const roles = guard.config.dbRoles.roles
  const roleNames = Object.keys(roles).toSorted()
  for (const name of roleNames) {
    const spec = roles[name]
    if (spec === undefined) continue
    out.push({
      kind: 'create-role',
      name,
      bypassesRls: spec.bypassesRls ?? false,
      nologin: spec.nologin ?? false,
    })
  }
  for (const child of roleNames) {
    const spec = roles[child]
    if (spec === undefined) continue
    const parents = [...spec.inherits].toSorted()
    for (const parent of parents) {
      out.push({ kind: 'grant-role-membership', parent, child })
    }
  }
}

function appendPolicyOps(
  out: Op[],
  guard: GuarddogLike,
  resolveTable: (modelName: string) => string,
  rlsTables: Set<string>
): void {
  const policies = [...guard.getPolicies()].toSorted(comparePolicyAst)
  for (const pol of policies) {
    const table = pol.table ?? resolveTable(pol.model)
    let added = false
    if (pol.select) {
      out.push(makeCreatePolicyOp(pol.model, table, pol.dbRole, 'select', pol.select.using, undefined, pol.todos))
      added = true
    }
    if (pol.insert) {
      out.push(makeCreatePolicyOp(pol.model, table, pol.dbRole, 'insert', undefined, pol.insert.check, pol.todos))
      added = true
    }
    if (pol.update) {
      out.push(
        makeCreatePolicyOp(pol.model, table, pol.dbRole, 'update', pol.update.using, pol.update.check, pol.todos)
      )
      added = true
    }
    if (pol.delete) {
      out.push(makeCreatePolicyOp(pol.model, table, pol.dbRole, 'delete', pol.delete.using, undefined, pol.todos))
      added = true
    }
    if (added) rlsTables.add(table)
  }
}

function appendPolymorphicOps(
  out: Op[],
  guard: GuarddogLike,
  resolveTable: (modelName: string) => string,
  rlsTables: Set<string>
): void {
  const polys = [...guard.getPolymorphics()].toSorted((a, b) => a.modelName.localeCompare(b.modelName))
  for (const poly of polys) {
    const table = poly.table ?? resolveTable(poly.modelName)
    const targets = [...poly.targets].toSorted((a, b) => a.discriminatorValue.localeCompare(b.discriminatorValue))
    for (const target of targets) {
      const policies = [...target.policies].toSorted((a, b) => a.dbRole.localeCompare(b.dbRole))
      for (const pol of policies) {
        appendPolymorphicTargetPolicy(out, poly, target, pol, table, rlsTables)
      }
    }
  }
}

function appendPolymorphicTargetPolicy(
  out: Op[],
  poly: PolymorphicAst,
  target: PolymorphicTargetAst,
  pol: PolymorphicTargetPolicyAst,
  table: string,
  rlsTables: Set<string>
): void {
  const fuse = (e: Expr): Expr => fuseDiscriminator(poly.discriminator, target.discriminatorValue, e)
  let added = false
  if (pol.select) {
    out.push(
      makePolymorphicPolicyOp(
        poly.modelName,
        table,
        pol.dbRole,
        'select',
        fuse(pol.select.using),
        undefined,
        pol.todos,
        poly.discriminator,
        target.discriminatorValue
      )
    )
    added = true
  }
  if (pol.insert) {
    out.push(
      makePolymorphicPolicyOp(
        poly.modelName,
        table,
        pol.dbRole,
        'insert',
        undefined,
        fuse(pol.insert.check),
        pol.todos,
        poly.discriminator,
        target.discriminatorValue
      )
    )
    added = true
  }
  if (pol.update) {
    out.push(
      makePolymorphicPolicyOp(
        poly.modelName,
        table,
        pol.dbRole,
        'update',
        fuse(pol.update.using),
        fuse(pol.update.check),
        pol.todos,
        poly.discriminator,
        target.discriminatorValue
      )
    )
    added = true
  }
  if (pol.delete) {
    out.push(
      makePolymorphicPolicyOp(
        poly.modelName,
        table,
        pol.dbRole,
        'delete',
        fuse(pol.delete.using),
        undefined,
        pol.todos,
        poly.discriminator,
        target.discriminatorValue
      )
    )
    added = true
  }
  if (added) rlsTables.add(table)
}

function appendRlsOps(out: Op[], rlsTables: Set<string>): void {
  const tables = [...rlsTables].toSorted()
  for (const t of tables) out.push({ kind: 'enable-rls', table: t })
  for (const t of tables) out.push({ kind: 'force-rls', table: t })
}

function appendColumnPrivilegeOps(out: Op[], guard: GuarddogLike, resolveTable: (modelName: string) => string): void {
  const cps = [...guard.getColumnPrivileges()].toSorted((a, b) => a.model.localeCompare(b.model))
  for (const cp of cps) {
    const table = cp.table ?? resolveTable(cp.model)
    const columns = Object.keys(cp.columns).toSorted()
    for (const column of columns) {
      const grant: ColumnPrivilegeGrant = cp.columns[column]!
      appendColumnVerbGrants(out, table, column, 'select', grant.select)
      appendColumnVerbGrants(out, table, column, 'insert', grant.insert)
      appendColumnVerbGrants(out, table, column, 'update', grant.update)
    }
  }
}

function appendColumnVerbGrants(
  out: Op[],
  table: string,
  column: string,
  verb: ColumnVerb,
  roles: ReadonlyArray<string>
): void {
  const sorted = [...roles].toSorted()
  for (const role of sorted) {
    out.push({ kind: 'grant-column', table, column, verb, role })
  }
}

function makeCreatePolicyOp(
  model: string,
  table: string,
  dbRole: string,
  verb: Verb,
  using: Expr | undefined,
  check: Expr | undefined,
  todos: ReadonlyArray<string>
): Op {
  const name = policyName({ table, dbRole, verb })
  const policy: PolicyOpRecord = Object.freeze({
    name,
    model,
    table,
    dbRole,
    verb,
    using,
    check,
    todos: Object.freeze([...todos]),
    discriminator: undefined,
  })
  return { kind: 'create-policy', policy }
}

function makePolymorphicPolicyOp(
  model: string,
  table: string,
  dbRole: string,
  verb: Verb,
  using: Expr | undefined,
  check: Expr | undefined,
  todos: ReadonlyArray<string>,
  discriminatorColumn: string,
  discriminatorValue: string
): Op {
  const name = policyName({ table, dbRole, verb, discriminatorValue })
  const policy: PolicyOpRecord = Object.freeze({
    name,
    model,
    table,
    dbRole,
    verb,
    using,
    check,
    todos: Object.freeze([...todos]),
    discriminator: Object.freeze({ column: discriminatorColumn, value: discriminatorValue }),
  })
  return { kind: 'create-policy', policy }
}

function fuseDiscriminator(column: string, value: string, inner: Expr): Expr {
  const eq: Expr = Object.freeze({
    kind: 'binop',
    op: 'eq',
    left: Object.freeze({ kind: 'col', column }) as Expr,
    right: Object.freeze({ kind: 'literal', value }) as Expr,
  })
  return Object.freeze({ kind: 'and', operands: Object.freeze([eq, inner]) }) as Expr
}

function comparePolicyAst(a: PolicyAst, b: PolicyAst): number {
  const t = (a.table ?? a.model).localeCompare(b.table ?? b.model)
  if (t !== 0) return t
  const r = a.dbRole.localeCompare(b.dbRole)
  if (r !== 0) return r
  return a.model.localeCompare(b.model)
}

// --------------------------------------------------------------------------
// diffStates internals
// --------------------------------------------------------------------------

function diffPolicies(current: State, target: State, drops: Op[], adds: Op[]): void {
  const allKeys = new Set<string>([...current.policies.keys(), ...target.policies.keys()])
  for (const key of [...allKeys].toSorted()) {
    const c = current.policies.get(key)
    const t = target.policies.get(key)
    if (c && !t) {
      drops.push({ kind: 'drop-policy', table: c.table, name: c.name })
    } else if (!c && t) {
      adds.push({ kind: 'create-policy', policy: t })
    } else if (c && t && !policyRecordsEqual(c, t)) {
      drops.push({ kind: 'drop-policy', table: c.table, name: c.name })
      adds.push({ kind: 'create-policy', policy: t })
    }
  }
}

function diffColumnGrants(current: State, target: State, drops: Op[], adds: Op[]): void {
  for (const key of [...current.columnGrants.keys()].toSorted()) {
    if (!target.columnGrants.has(key)) {
      const g: ColumnGrantRecord = current.columnGrants.get(key)!
      drops.push({ kind: 'revoke-column', table: g.table, column: g.column, verb: g.verb, role: g.role })
    }
  }
  for (const key of [...target.columnGrants.keys()].toSorted()) {
    if (!current.columnGrants.has(key)) {
      const g: ColumnGrantRecord = target.columnGrants.get(key)!
      adds.push({ kind: 'grant-column', table: g.table, column: g.column, verb: g.verb, role: g.role })
    }
  }
}

function diffRoleMemberships(current: State, target: State, drops: Op[]): void {
  for (const key of [...current.roleMemberships.keys()].toSorted()) {
    if (!target.roleMemberships.has(key)) {
      const m: RoleMembershipRecord = current.roleMemberships.get(key)!
      drops.push({ kind: 'revoke-role-membership', parent: m.parent, child: m.child })
    }
  }
}

function diffRoleMembershipAdds(current: State, target: State, adds: Op[]): void {
  for (const key of [...target.roleMemberships.keys()].toSorted()) {
    if (!current.roleMemberships.has(key)) {
      const m: RoleMembershipRecord = target.roleMemberships.get(key)!
      adds.push({ kind: 'grant-role-membership', parent: m.parent, child: m.child })
    }
  }
}

function diffRlsRemovals(current: State, target: State, drops: Op[]): void {
  for (const t of [...current.rlsForced].toSorted()) {
    if (!target.rlsForced.has(t)) drops.push({ kind: 'unforce-rls', table: t })
  }
  for (const t of [...current.rlsEnabled].toSorted()) {
    if (!target.rlsEnabled.has(t)) drops.push({ kind: 'disable-rls', table: t })
  }
}

function diffRlsAdds(current: State, target: State, adds: Op[]): void {
  for (const t of [...target.rlsEnabled].toSorted()) {
    if (!current.rlsEnabled.has(t)) adds.push({ kind: 'enable-rls', table: t })
  }
  for (const t of [...target.rlsForced].toSorted()) {
    if (!current.rlsForced.has(t)) adds.push({ kind: 'force-rls', table: t })
  }
}

function diffRoles(current: State, target: State, drops: Op[], adds: Op[]): void {
  const currentNames = new Set(current.roles.keys())
  const targetNames = new Set(target.roles.keys())
  for (const name of [...currentNames].toSorted()) {
    if (!targetNames.has(name)) drops.push({ kind: 'drop-role', name })
  }
  for (const name of [...targetNames].toSorted()) {
    const t: RoleRecord = target.roles.get(name)!
    const c = current.roles.get(name)
    if (c === undefined) {
      adds.push({ kind: 'create-role', name, bypassesRls: t.bypassesRls, nologin: t.nologin })
    } else if (c.bypassesRls !== t.bypassesRls || c.nologin !== t.nologin) {
      // Treat attribute drift as drop+create (matches the idempotent emitter
      // pattern and avoids ALTER ROLE complexity).
      drops.push({ kind: 'drop-role', name })
      adds.push({ kind: 'create-role', name, bypassesRls: t.bypassesRls, nologin: t.nologin })
    }
  }
}

function policyRecordsEqual(a: PolicyOpRecord, b: PolicyOpRecord): boolean {
  if (a.name !== b.name) return false
  if (a.model !== b.model) return false
  if (a.table !== b.table) return false
  if (a.dbRole !== b.dbRole) return false
  if (a.verb !== b.verb) return false
  if (!exprEqual(a.using, b.using)) return false
  if (!exprEqual(a.check, b.check)) return false
  if (a.todos.length !== b.todos.length) return false
  for (let i = 0; i < a.todos.length; i++) if (a.todos[i] !== b.todos[i]) return false
  const ad = a.discriminator
  const bd = b.discriminator
  if ((ad === undefined) !== (bd === undefined)) return false
  if (ad && bd && (ad.column !== bd.column || ad.value !== bd.value)) return false
  return true
}

function exprEqual(a: Expr | undefined, b: Expr | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'literal':
      return (b as typeof a).value === a.value
    case 'col':
      return (b as typeof a).column === a.column
    case 'claim':
      return (b as typeof a).path === a.path
    case 'binop': {
      const bb = b as typeof a
      return bb.op === a.op && exprEqual(a.left, bb.left) && exprEqual(a.right, bb.right)
    }
    case 'and':
    case 'or': {
      const bb = b as typeof a
      if (a.operands.length !== bb.operands.length) return false
      for (let i = 0; i < a.operands.length; i++) {
        if (!exprEqual(a.operands[i], bb.operands[i])) return false
      }
      return true
    }
    case 'not':
      return exprEqual(a.operand, (b as typeof a).operand)
    case 'hasAppRole':
      return (b as typeof a).role === a.role
    case 'hasGrant': {
      const bb = b as typeof a
      return bb.action === a.action && bb.scopeColumn === a.scopeColumn
    }
    case 'hasResourcePermission': {
      const bb = b as typeof a
      return bb.action === a.action && bb.jsonbColumn === a.jsonbColumn
    }
    case 'isOwner':
      return (b as typeof a).ownerColumn === a.ownerColumn
    case 'inArray': {
      const bb = b as typeof a
      return exprEqual(a.needle, bb.needle) && exprEqual(a.haystack, bb.haystack)
    }
    case 'raw':
      return (b as typeof a).sql === a.sql
  }
}
