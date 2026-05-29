/**
 * `defineFunctions` — declare SQL helper functions as first-class, guarddog-
 * managed objects (ADR-0026). guarddog emits the `CREATE OR REPLACE FUNCTION`
 * DDL, the target schema, and EXECUTE grants, and diffs them across runs like
 * policies. This keeps emission self-contained (ADR-0001) while supporting
 * reused, non-trivial authorization logic that the declarative grant config
 * can't express — e.g. a creator-implicit-OWNER clause, bespoke JOIN shapes,
 * or a shared rank-mapper referenced by every grant check.
 *
 *     defineFunctions({
 *       schema: 'app',
 *       fns: {
 *         resource_role_ordinal: {
 *           args: [{ name: 'role_text', type: 'text' }],
 *           returns: 'integer',
 *           volatility: 'immutable',
 *           parallel: 'safe',
 *           body: `SELECT CASE role_text WHEN 'OWNER' THEN 4 ... END`,
 *         },
 *         user_has_workspace_grant: {
 *           args: [
 *             { name: 'workspace_id_in', type: 'text' },
 *             { name: 'user_id_in', type: 'text' },
 *             { name: 'min_role_in', type: 'text', default: 'NULL' },
 *           ],
 *           returns: 'boolean',
 *           volatility: 'stable',
 *           security: 'definer',
 *           searchPath: ['pg_catalog', 'public'],
 *           dependsOn: ['resource_role_ordinal'],
 *           grants: { execute: ['app_user', 'app_system'] },
 *           body: `SELECT EXISTS (...)`,
 *         },
 *       },
 *     })
 *
 * Reference a managed function from a policy with `p.fn(name, ...args)` — the
 * name autocompletes against the declared functions and arity is checked.
 */

export type FunctionLanguage = 'sql' | 'plpgsql'
export type FunctionVolatility = 'immutable' | 'stable' | 'volatile'
export type FunctionParallel = 'safe' | 'restricted' | 'unsafe'
export type FunctionSecurity = 'invoker' | 'definer'

export interface FunctionArg {
  /** Argument name (becomes a named parameter in the function signature). */
  readonly name: string
  /** Postgres type, e.g. `text`, `integer`, `"ResourceRole"`. Inserted verbatim. */
  readonly type: string
  /** Raw SQL default expression (e.g. `NULL`). Trailing-only, per Postgres. */
  readonly default?: string
}

export interface FunctionDefinition {
  readonly args: ReadonlyArray<FunctionArg>
  /** Return type, e.g. `boolean`, `integer`, `text`. Inserted verbatim. */
  readonly returns: string
  /** Default `sql`. */
  readonly language?: FunctionLanguage
  /** Default `volatile` (Postgres default). */
  readonly volatility?: FunctionVolatility
  /** Default `unsafe` (Postgres default). */
  readonly parallel?: FunctionParallel
  /** Default `invoker`. `definer` for functions that read tables under RLS. */
  readonly security?: FunctionSecurity
  /** `SET search_path TO ...` — recommended for SECURITY DEFINER functions. */
  readonly searchPath?: ReadonlyArray<string>
  /** Names of other functions in this map this one calls — drives emission order. */
  readonly dependsOn?: ReadonlyArray<string>
  /** Roles to GRANT EXECUTE to. */
  readonly grants?: { readonly execute?: ReadonlyArray<string> }
  /** Function body SQL (opaque, trusted string — same trust level as rawSql). */
  readonly body: string
}

export interface FunctionsDefinition<
  TFns extends Record<string, FunctionDefinition> = Record<string, FunctionDefinition>,
> {
  /** Target schema (guarddog emits `CREATE SCHEMA IF NOT EXISTS`). */
  readonly schema: string
  readonly fns: Readonly<TFns>
}

const LANGUAGES: ReadonlySet<string> = new Set<FunctionLanguage>(['sql', 'plpgsql'])
const VOLATILITIES: ReadonlySet<string> = new Set<FunctionVolatility>(['immutable', 'stable', 'volatile'])
const PARALLELS: ReadonlySet<string> = new Set<FunctionParallel>(['safe', 'restricted', 'unsafe'])
const SECURITIES: ReadonlySet<string> = new Set<FunctionSecurity>(['invoker', 'definer'])

export function defineFunctions<const TFns extends Record<string, FunctionDefinition>>(config: {
  readonly schema: string
  readonly fns: TFns
}): FunctionsDefinition<TFns> {
  if (config.schema.length === 0) {
    throw new Error(
      '[prisma-guarddog] defineFunctions: schema must be a non-empty string (the target Postgres schema).'
    )
  }
  const names = Object.keys(config.fns)
  if (names.length === 0) {
    throw new Error('[prisma-guarddog] defineFunctions: fns must declare at least one function.')
  }
  const nameSet = new Set(names)
  for (const [name, def] of Object.entries(config.fns) as Array<[string, FunctionDefinition]>) {
    validateFunction(name, def, nameSet)
  }
  assertNoDependencyCycle(config.fns as Record<string, FunctionDefinition>)

  return Object.freeze({
    schema: config.schema,
    fns: Object.freeze({ ...config.fns }) as Readonly<TFns>,
  })
}

function validateFunction(name: string, def: FunctionDefinition, declaredNames: ReadonlySet<string>): void {
  const where = `[prisma-guarddog] defineFunctions: fns["${name}"]`
  if (name.length === 0) throw new Error('[prisma-guarddog] defineFunctions: function names must be non-empty strings.')
  if (def.returns.length === 0) throw new Error(`${where}: returns must be a non-empty string.`)
  if (def.body.length === 0) throw new Error(`${where}: body must be a non-empty string.`)

  const seenArgs = new Set<string>()
  let sawDefault = false
  for (const arg of def.args) {
    if (arg.name.length === 0) throw new Error(`${where}: argument names must be non-empty strings.`)
    if (arg.type.length === 0) throw new Error(`${where}: argument "${arg.name}" type must be a non-empty string.`)
    if (seenArgs.has(arg.name)) throw new Error(`${where}: duplicate argument "${arg.name}".`)
    seenArgs.add(arg.name)
    if (arg.default !== undefined) {
      sawDefault = true
    } else if (sawDefault) {
      throw new Error(
        `${where}: argument "${arg.name}" has no default but follows a defaulted argument. ` +
          'Postgres requires defaulted arguments to be trailing.'
      )
    }
  }

  if (def.language !== undefined && !LANGUAGES.has(def.language)) {
    throw new Error(`${where}: language must be one of sql | plpgsql.`)
  }
  if (def.volatility !== undefined && !VOLATILITIES.has(def.volatility)) {
    throw new Error(`${where}: volatility must be one of immutable | stable | volatile.`)
  }
  if (def.parallel !== undefined && !PARALLELS.has(def.parallel)) {
    throw new Error(`${where}: parallel must be one of safe | restricted | unsafe.`)
  }
  if (def.security !== undefined && !SECURITIES.has(def.security)) {
    throw new Error(`${where}: security must be one of invoker | definer.`)
  }
  if (def.searchPath !== undefined) {
    for (const p of def.searchPath) {
      if (p.length === 0) throw new Error(`${where}: searchPath entries must be non-empty strings.`)
    }
  }
  for (const dep of def.dependsOn ?? []) {
    if (dep === name) throw new Error(`${where}: a function cannot dependsOn itself.`)
    if (!declaredNames.has(dep)) {
      throw new Error(`${where}: dependsOn references "${dep}", which is not a declared function in this fns{} map.`)
    }
  }
  for (const role of def.grants?.execute ?? []) {
    if (role.length === 0) throw new Error(`${where}: grants.execute role names must be non-empty strings.`)
  }
}

/**
 * Detect a cycle in the `dependsOn` graph (which would make emission order
 * impossible). Throws naming the cycle. DFS with a recursion stack.
 */
function assertNoDependencyCycle(fns: Record<string, FunctionDefinition>): void {
  const visiting = new Set<string>()
  const done = new Set<string>()
  const stack: string[] = []

  const visit = (name: string): void => {
    if (done.has(name)) return
    if (visiting.has(name)) {
      const cycle = [...stack.slice(stack.indexOf(name)), name].join(' -> ')
      throw new Error(`[prisma-guarddog] defineFunctions: dependsOn cycle detected: ${cycle}.`)
    }
    visiting.add(name)
    stack.push(name)
    for (const dep of fns[name]?.dependsOn ?? []) visit(dep)
    stack.pop()
    visiting.delete(name)
    done.add(name)
  }

  for (const name of Object.keys(fns)) visit(name)
}

/**
 * Topologically order the functions so dependencies are emitted before their
 * dependents. Stable: ties broken by declaration order. Assumes the graph is
 * acyclic (validated at construction).
 */
export function orderFunctions(def: FunctionsDefinition): ReadonlyArray<{ name: string; fn: FunctionDefinition }> {
  const fns = def.fns as Record<string, FunctionDefinition>
  const ordered: Array<{ name: string; fn: FunctionDefinition }> = []
  const placed = new Set<string>()

  const place = (name: string): void => {
    if (placed.has(name)) return
    for (const dep of fns[name]?.dependsOn ?? []) place(dep)
    placed.add(name)
    ordered.push({ name, fn: fns[name]! })
  }

  for (const name of Object.keys(fns)) place(name)
  return ordered
}
