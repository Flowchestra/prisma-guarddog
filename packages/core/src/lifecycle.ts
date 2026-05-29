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
import { type FunctionDefinition, type FunctionsDefinition, orderFunctions } from './function-defs.js'
import { defaultTableResolver, policyName } from './naming.js'
import {
  applyOps,
  type ColumnGrantRecord,
  type ColumnVerb,
  empty,
  type FunctionArgRecord,
  functionKey,
  type FunctionOpRecord,
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
  /** Optional (ADR-0026). Absent on Guarddog-likes that predate managed functions. */
  getFunctions?(): FunctionsDefinition | undefined
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
  const schemaOps: Op[] = []
  const functionOps: Op[] = []
  const executeGrantOps: Op[] = []
  const policyOps: Op[] = []
  const columnGrantOps: Op[] = []
  const rlsTables = new Set<string>()

  appendRoleOps(roleOps, guard)
  appendFunctionOps(schemaOps, functionOps, executeGrantOps, guard)
  appendPolicyOps(policyOps, guard, resolveTable, rlsTables)
  appendPolymorphicOps(policyOps, guard, resolveTable, rlsTables)
  appendColumnPrivilegeOps(columnGrantOps, guard, resolveTable)

  const rlsOps: Op[] = []
  appendRlsOps(rlsOps, rlsTables)

  return Object.freeze([
    ...roleOps,
    ...schemaOps,
    ...functionOps,
    ...executeGrantOps,
    ...rlsOps,
    ...policyOps,
    ...columnGrantOps,
  ])
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
 *   1. drop policies (before the functions they call, before disable-rls/drop-role)
 *   2. revoke column grants
 *   3. revoke EXECUTE grants
 *   4. drop functions (after the policies that call them are gone)
 *   5. revoke role memberships
 *   6. unforce / disable RLS for tables no longer policied
 *   7. drop roles (after all dependents are gone)
 *   8. create roles
 *   9. create schemas, then functions (dependency-ordered)
 *  10. grant EXECUTE (after roles + functions exist)
 *  11. grant role memberships
 *  12. enable / force RLS for newly-policied tables
 *  13. create policies (after the functions they call exist)
 *  14. grant column grants
 *
 * Drop-then-recreate semantics for policy mutations (Postgres
 * `ALTER POLICY` only supports a subset of changes; we always emit a clean
 * pair instead, matching the idempotency pattern the emitter uses).
 * Functions use the same drop+recreate pattern on a signature change and
 * `CREATE OR REPLACE` for body/attribute-only changes — see `diffFunctions`.
 */
export function diffStates(current: State, target: State): readonly Op[] {
  // Drop phase: tear down dependents before their dependencies.
  const dropPolicies: Op[] = []
  const dropColumnGrants: Op[] = []
  const revokeExecute: Op[] = []
  const dropFunctions: Op[] = []
  const dropMemberships: Op[] = []
  const rlsRemovals: Op[] = []
  const dropRoles: Op[] = []

  // Add phase: bring dependencies up before dependents.
  const addRoles: Op[] = []
  const addSchemas: Op[] = []
  const addFunctions: Op[] = []
  const addExecute: Op[] = []
  const addMemberships: Op[] = []
  const rlsAdds: Op[] = []
  const addPolicies: Op[] = []
  const addColumnGrants: Op[] = []

  // Functions dropped+recreated due to a signature change. Their grants are
  // wiped by the DROP, so they must be re-granted (and their stale grants must
  // NOT be revoked — the object is already gone).
  const recreated = new Set<string>()

  diffPolicies(current, target, dropPolicies, addPolicies)
  diffColumnGrants(current, target, dropColumnGrants, addColumnGrants)
  diffFunctions(current, target, dropFunctions, addSchemas, addFunctions, recreated)
  diffFunctionGrants(current, target, revokeExecute, addExecute, recreated)
  diffRoleMemberships(current, target, dropMemberships)
  diffRoleMembershipAdds(current, target, addMemberships)
  diffRlsRemovals(current, target, rlsRemovals)
  diffRlsAdds(current, target, rlsAdds)
  diffRoles(current, target, dropRoles, addRoles)

  return Object.freeze([
    ...dropPolicies,
    ...dropColumnGrants,
    ...revokeExecute,
    ...dropFunctions,
    ...dropMemberships,
    ...rlsRemovals,
    ...dropRoles,
    ...addRoles,
    ...addSchemas,
    ...addFunctions,
    ...addExecute,
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

/**
 * Emit the schema-create, function-create, and execute-grant ops for the
 * guarddog-managed functions (ADR-0026). Functions are emitted in
 * dependency order (via `orderFunctions`) so a dependent never precedes the
 * function it calls — this ordering is preserved in the target State's
 * insertion order and relied on by `diffFunctions` for safe replay.
 */
function appendFunctionOps(schemaOut: Op[], fnOut: Op[], grantOut: Op[], guard: GuarddogLike): void {
  const defn = guard.getFunctions?.()
  if (defn === undefined) return
  schemaOut.push({ kind: 'create-schema', schema: defn.schema })
  for (const { name, fn } of orderFunctions(defn)) {
    const argTypes = fn.args.map((a) => a.type)
    fnOut.push({ kind: 'create-function', fn: toFunctionOpRecord(defn.schema, name, fn) })
    for (const role of [...(fn.grants?.execute ?? [])].toSorted()) {
      grantOut.push({ kind: 'grant-execute', schema: defn.schema, name, role, argTypes })
    }
  }
}

function toFunctionOpRecord(schema: string, name: string, fn: FunctionDefinition): FunctionOpRecord {
  const args: ReadonlyArray<FunctionArgRecord> = Object.freeze(
    fn.args.map((a) => Object.freeze({ name: a.name, type: a.type, default: a.default }))
  )
  return Object.freeze({
    schema,
    name,
    args,
    returns: fn.returns,
    language: fn.language ?? 'sql',
    volatility: fn.volatility ?? 'volatile',
    parallel: fn.parallel ?? 'unsafe',
    security: fn.security ?? 'invoker',
    searchPath: Object.freeze([...(fn.searchPath ?? [])]),
    body: fn.body,
    signature: functionSignature(schema, name, args, fn.returns),
  })
}

/**
 * The parts of a function `CREATE OR REPLACE` cannot change: arg names, arg
 * types (in order), and the return type. A difference here forces a
 * DROP+CREATE in the diff. Defaults and the body are intentionally excluded —
 * those a `CREATE OR REPLACE` handles in place.
 */
function functionSignature(
  schema: string,
  name: string,
  args: ReadonlyArray<FunctionArgRecord>,
  returns: string
): string {
  const sig = args.map((a) => `${a.name} ${a.type}`).join(', ')
  return `${schema}.${name}(${sig}) -> ${returns}`
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

/**
 * Signature-aware function diffing (ADR-0026):
 *
 *   - present in target, absent in current        → CREATE (OR REPLACE)
 *   - present in current, absent in target         → DROP
 *   - present in both, signature changed           → DROP + CREATE (recreated)
 *   - present in both, only body/attrs changed     → CREATE OR REPLACE
 *
 * Drops run in reverse target-insertion / current-insertion order and creates
 * in forward target-insertion order, which (because compileToOps emits in
 * dependency order) keeps dependents and dependencies on the right side of
 * each other. Schemas are create-only — never dropped, since a schema can hold
 * objects guarddog doesn't manage.
 */
function diffFunctions(
  current: State,
  target: State,
  drops: Op[],
  addSchemas: Op[],
  adds: Op[],
  recreated: Set<string>
): void {
  for (const schema of [...target.schemas].toSorted()) {
    if (!current.schemas.has(schema)) addSchemas.push({ kind: 'create-schema', schema })
  }

  // Drops in reverse dependency order (reverse of current insertion order).
  for (const key of [...current.functions.keys()].toReversed()) {
    const c = current.functions.get(key)!
    const t = target.functions.get(key)
    const argTypes = c.args.map((a) => a.type)
    if (t === undefined) {
      drops.push({ kind: 'drop-function', schema: c.schema, name: c.name, argTypes })
    } else if (c.signature !== t.signature) {
      drops.push({ kind: 'drop-function', schema: c.schema, name: c.name, argTypes })
      recreated.add(key)
    }
  }

  // Creates / replaces in forward dependency order (target insertion order).
  for (const [key, t] of target.functions) {
    const c = current.functions.get(key)
    if (c === undefined || recreated.has(key) || !functionRecordsEqual(c, t)) {
      adds.push({ kind: 'create-function', fn: t })
    }
  }
}

function diffFunctionGrants(current: State, target: State, revokes: Op[], grants: Op[], recreated: Set<string>): void {
  for (const key of [...current.functionGrants.keys()].toSorted()) {
    if (target.functionGrants.has(key)) continue
    const g = current.functionGrants.get(key)!
    const fnKey = functionKey(g.schema, g.name)
    // If the function is being dropped or recreated, the DROP already removed
    // its grants — an explicit REVOKE would be redundant (or hit a stale
    // signature). Skip it.
    if (recreated.has(fnKey) || !target.functions.has(fnKey)) continue
    revokes.push({ kind: 'revoke-execute', schema: g.schema, name: g.name, role: g.role, argTypes: g.argTypes })
  }
  for (const key of [...target.functionGrants.keys()].toSorted()) {
    const g = target.functionGrants.get(key)!
    const fnRecreated = recreated.has(functionKey(g.schema, g.name))
    if (!current.functionGrants.has(key) || fnRecreated) {
      grants.push({ kind: 'grant-execute', schema: g.schema, name: g.name, role: g.role, argTypes: g.argTypes })
    }
  }
}

function functionRecordsEqual(a: FunctionOpRecord, b: FunctionOpRecord): boolean {
  if (a.signature !== b.signature) return false
  if (a.language !== b.language) return false
  if (a.volatility !== b.volatility) return false
  if (a.parallel !== b.parallel) return false
  if (a.security !== b.security) return false
  if (a.body !== b.body) return false
  if (a.searchPath.length !== b.searchPath.length) return false
  for (let i = 0; i < a.searchPath.length; i++) if (a.searchPath[i] !== b.searchPath[i]) return false
  if (a.args.length !== b.args.length) return false
  for (let i = 0; i < a.args.length; i++) {
    // names + types are in the signature; only `default` is still uncompared.
    if (a.args[i]!.default !== b.args[i]!.default) return false
  }
  return true
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
      return bb.action === a.action && bb.scopeColumn === a.scopeColumn && bb.tableHint === a.tableHint
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
    case 'fn': {
      const bb = b as typeof a
      if (bb.name !== a.name || a.args.length !== bb.args.length) return false
      for (let i = 0; i < a.args.length; i++) {
        if (!exprEqual(a.args[i], bb.args[i])) return false
      }
      return true
    }
    case 'raw':
      return (b as typeof a).sql === a.sql
  }
}
