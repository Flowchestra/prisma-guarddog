/**
 * `Guarddog` — the policy registry and orchestrator.
 *
 * Authoring flow:
 *
 *     const guard = new Guarddog({
 *       claims:        defineClaims({ ... }),
 *       dbRoles:       defineDbRoles({ ... }),
 *       appRoles: defineAppRoles({ ... }),
 *       resources:     defineResources({ ... }),
 *     });
 *
 *     guard.model('Workbench')
 *       .policy('app_user')
 *       .select(p => p.claim('tenantId').eq(col('tenantId'))
 *                     .and(p.hasGrant('workspace.admin', col('workspaceId'))))
 *       .insert({ check: p => p.hasGrant('workspace.editor', col('workspaceId')) })
 *       .update({
 *         using: p => p.isOwner(col('ownerId')),
 *         check: p => p.hasGrant('workspace.admin', col('workspaceId')),
 *       })
 *       .delete({ using: p => p.hasGrant('workspace.admin', col('workspaceId')) });
 *
 * `.policy()` always returns the same `PolicyBuilder` instance for a given
 * (model, dbRole) pair within a Guarddog — repeated `.policy('app_user')` on
 * the same model is idempotent, so split authoring across files is safe.
 *
 * Snapshots: `guard.getPolicies()` returns a deeply-frozen `PolicyAst[]` for
 * emitter consumption. The Guarddog instance can keep being mutated after a
 * snapshot — new snapshots reflect the latest state.
 */

import type { AppRolesDefinition } from './app-roles.js'
import type {
  AllSpec,
  ColumnPrivilegeAst,
  ColumnPrivilegeGrant,
  DeleteSpec,
  Expr,
  InsertSpec,
  NoPolicyAst,
  PolicyAst,
  PolymorphicAst,
  SelectSpec,
  UpdateSpec,
  Verb,
} from './ast.js'
import type { ClaimsDefinition, ClaimsShape, InferClaims } from './claims.js'
import type { DbRolesDefinition } from './db-roles.js'
import type { FunctionDefinition, FunctionsDefinition } from './function-defs.js'
import { PolymorphicBuilder } from './polymorphic.js'
import { FluentExpr, PredicateBuilder } from './predicate.js'
import type { ResourceGrantsDefinition } from './resource-grants.js'
import type { ResourceTreeDefinition } from './resources.js'

export interface GuarddogConfig<
  TClaimsShape extends ClaimsShape,
  TDbRoles extends string,
  TAppRoles extends string,
  TResources extends string,
  TActions extends string = string,
  TGrantTableKeys extends string = string,
  TFunctions extends Record<string, FunctionDefinition> = Record<string, FunctionDefinition>,
> {
  readonly claims: ClaimsDefinition<TClaimsShape>
  readonly dbRoles: DbRolesDefinition<TDbRoles>
  readonly appRoles: AppRolesDefinition<TAppRoles>
  readonly resources: ResourceTreeDefinition<TResources>
  /**
   * Optional resource-grants layer (layer 3). Required if any policy uses
   * `p.hasGrant(action, col)`. Omit for projects using only dbRoles +
   * appRoles + per-resource jsonb permissions.
   *
   * `TGrantTableKeys` (inferred from a table-source `tables` map) flows to
   * `p.hasGrant(..., { table })` so the hint autocompletes against the
   * declared keys. See ADR-0025 / #12.
   */
  readonly resourceGrants?: ResourceGrantsDefinition<TActions, TGrantTableKeys>
  /**
   * Optional guarddog-managed SQL functions (ADR-0026). Required if any
   * policy uses `p.fn(name, ...)`. `TFunctions` (inferred from the `fns`
   * map) flows to `p.fn(...)` so the name autocompletes and arity is checked
   * against the declared functions.
   */
  readonly functions?: FunctionsDefinition<TFunctions>
}

type PredicateFn<
  TClaims,
  TGrantTableKeys extends string = string,
  TFunctions extends Record<string, FunctionDefinition> = Record<string, FunctionDefinition>,
  TColumns extends string = string,
> = (p: PredicateBuilder<TClaims, TGrantTableKeys, TFunctions, TColumns>) => FluentExpr

export class Guarddog<
  TClaimsShape extends ClaimsShape = ClaimsShape,
  TDbRoles extends string = string,
  TAppRoles extends string = string,
  TResources extends string = string,
  TActions extends string = string,
  TGrantTableKeys extends string = string,
  TFunctions extends Record<string, FunctionDefinition> = Record<string, FunctionDefinition>,
  TModels extends Record<string, string> = Record<string, string>,
> {
  readonly config: GuarddogConfig<TClaimsShape, TDbRoles, TAppRoles, TResources, TActions, TGrantTableKeys, TFunctions>
  private readonly _modelBuilders = new Map<string, ModelBuilder<TClaimsShape, TDbRoles, TGrantTableKeys, TFunctions>>()
  private readonly _policies = new Map<string, PolicyBuilder<TClaimsShape, TDbRoles, TGrantTableKeys, TFunctions>>()
  // Restrictive policies (ADR-0032). Separate registry because the AST shape
  // is `all`-spec only and the (model, dbRole) key space is independent of
  // permissive policies — a model can have both an `app_user` permissive
  // SELECT and a `public` restrictive isolation floor.
  private readonly _restrictivePolicies = new Map<
    string,
    RestrictivePolicyBuilder<TClaimsShape, TDbRoles, TGrantTableKeys, TFunctions>
  >()
  private readonly _noPolicies = new Map<string, NoPolicyAst>()
  private readonly _polymorphics = new Map<
    string,
    PolymorphicBuilder<TClaimsShape, TDbRoles, TGrantTableKeys, TFunctions>
  >()

  constructor(
    config: GuarddogConfig<TClaimsShape, TDbRoles, TAppRoles, TResources, TActions, TGrantTableKeys, TFunctions>
  ) {
    this.config = config
  }

  /**
   * Declare that a Prisma model intentionally has no policy. Required `reason`
   * makes the decision auditable — a `noPolicy` is a real decision, not a
   * forgotten one. The lint extension treats a model as covered if it has
   * either at least one `PolicyAst` OR a `NoPolicyAst` with a non-empty reason.
   *
   *   guard.noPolicy('MigrationLedger', {
   *     reason: 'system-only table; access gated by app_system role grants',
   *   });
   *
   * Calling `.noPolicy()` on a model that already has a policy throws — the
   * two are mutually exclusive at the coverage level.
   */
  noPolicy(modelName: string, opts: { reason: string }): this {
    if (modelName.length === 0) {
      throw new Error('[prisma-guarddog] Guarddog.noPolicy(): modelName must be a non-empty string.')
    }
    if (opts.reason.length === 0) {
      throw new Error(
        `[prisma-guarddog] Guarddog.noPolicy("${modelName}"): reason must be a non-empty string. ` +
          'A noPolicy declaration is a real decision; document why.'
      )
    }
    if (this._modelBuilders.has(modelName)) {
      throw new Error(
        `[prisma-guarddog] Guarddog.noPolicy("${modelName}"): cannot mark a model as noPolicy after it has had any builder activity. ` +
          'Remove the model() / policy() calls or remove the noPolicy() call.'
      )
    }
    if (this._polymorphics.has(modelName)) {
      throw new Error(
        `[prisma-guarddog] Guarddog.noPolicy("${modelName}"): this model was previously declared as polymorphic(). ` +
          'Remove the polymorphic() call or use a different model for noPolicy().'
      )
    }
    this._noPolicies.set(modelName, Object.freeze({ model: modelName, reason: opts.reason }))
    return this
  }

  /**
   * Begin authoring against a Prisma model. Repeated calls with the same
   * `modelName` return the same `ModelBuilder` so multi-file authoring is
   * idempotent.
   */
  model<M extends keyof TModels & string>(
    modelName: M
  ): ModelBuilder<TClaimsShape, TDbRoles, TGrantTableKeys, TFunctions, TModels[M]> {
    if (modelName.length === 0) {
      throw new Error('[prisma-guarddog] Guarddog.model(): modelName must be a non-empty string.')
    }
    if (this._noPolicies.has(modelName)) {
      throw new Error(
        `[prisma-guarddog] Guarddog.model("${modelName}"): this model was previously declared as noPolicy(). ` +
          'Remove the noPolicy() call if you want to declare a policy.'
      )
    }
    if (this._polymorphics.has(modelName)) {
      throw new Error(
        `[prisma-guarddog] Guarddog.model("${modelName}"): this model was previously declared as polymorphic(). ` +
          'Use either .model() or .polymorphic() for a given Prisma model, not both.'
      )
    }
    let builder = this._modelBuilders.get(modelName)
    if (builder === undefined) {
      builder = new ModelBuilder<TClaimsShape, TDbRoles, TGrantTableKeys, TFunctions>(this, modelName)
      this._modelBuilders.set(modelName, builder)
    }
    // The map stores builders with the unconstrained (string) column type; the
    // precise per-model column union (`TModels[M]`) lives only in the return
    // type. Runtime is identical, so the cast is sound (ADR-0028).
    return builder as unknown as ModelBuilder<TClaimsShape, TDbRoles, TGrantTableKeys, TFunctions, TModels[M]>
  }

  /**
   * @internal — called by PolicyBuilder during construction. Public consumers
   * should not call this directly.
   */
  _registerPolicy(key: string, builder: PolicyBuilder<TClaimsShape, TDbRoles, TGrantTableKeys, TFunctions>): void {
    const existing = this._policies.get(key)
    if (existing !== undefined && existing !== builder) {
      throw new Error(
        `[prisma-guarddog] Guarddog: refused to overwrite policy "${key}". This indicates a bug in the builder; report it.`
      )
    }
    this._policies.set(key, builder)
  }

  /**
   * @internal — returns the existing builder for (model, dbRole) if one
   * exists; otherwise undefined. Used by ModelBuilder.policy() to enforce
   * idempotence.
   */
  _findPolicy(key: string): PolicyBuilder<TClaimsShape, TDbRoles, TGrantTableKeys, TFunctions> | undefined {
    return this._policies.get(key)
  }

  /**
   * @internal — called by `ModelBuilder.restrictivePolicy()` (ADR-0032 +
   * ADR-0033). Registry is keyed by `${model}::${dbRole}::${slot}` so each
   * named slot has its own builder; same slot returns the same builder
   * (idempotent within a slot), different slots are independent.
   */
  _registerRestrictivePolicy(
    key: string,
    builder: RestrictivePolicyBuilder<TClaimsShape, TDbRoles, TGrantTableKeys, TFunctions>
  ): void {
    const existing = this._restrictivePolicies.get(key)
    if (existing !== undefined && existing !== builder) {
      throw new Error(
        `[prisma-guarddog] Guarddog: refused to overwrite restrictive policy "${key}". This indicates a bug in the builder; report it.`
      )
    }
    this._restrictivePolicies.set(key, builder)
  }

  /**
   * @internal — used by `ModelBuilder.restrictivePolicy()` and `.isolation()`
   * to enforce idempotence on the `(model, dbRole, slot)` key (ADR-0033).
   */
  _findRestrictivePolicy(
    key: string
  ): RestrictivePolicyBuilder<TClaimsShape, TDbRoles, TGrantTableKeys, TFunctions> | undefined {
    return this._restrictivePolicies.get(key)
  }

  /**
   * Construct the predicate builder threaded with the registered claim shape,
   * grant-table keys, and function names. `TCols` (the active model's column
   * union) is supplied by the caller (the policy builder) so `p.col(...)`
   * autocompletes; it defaults to `string` (ADR-0028).
   */
  _buildPredicate<TCols extends string = string>(): PredicateBuilder<
    InferClaims<ClaimsDefinition<TClaimsShape>>,
    TGrantTableKeys,
    TFunctions,
    TCols
  > {
    return new PredicateBuilder<InferClaims<ClaimsDefinition<TClaimsShape>>, TGrantTableKeys, TFunctions, TCols>()
  }

  /**
   * The guarddog-managed SQL functions declared in config, or undefined.
   * Emitter / lifecycle consume this to emit `CREATE OR REPLACE FUNCTION`
   * DDL and EXECUTE grants (ADR-0026).
   */
  getFunctions(): FunctionsDefinition<TFunctions> | undefined {
    return this.config.functions
  }

  /**
   * Deeply-frozen snapshot of every policy declared so far — permissive (from
   * `.policy()`) and restrictive (from `.restrictivePolicy()` / `.isolation()`,
   * ADR-0032) combined. Insertion order: all permissive in their registration
   * order, then all restrictive. Emitter consumes this.
   */
  getPolicies(): readonly PolicyAst[] {
    return Object.freeze([
      ...[...this._policies.values()].map((b) => b._toAst()),
      ...[...this._restrictivePolicies.values()].map((b) => b._toAst()),
    ])
  }

  /**
   * Deeply-frozen snapshot of every column-privilege declaration. Independent
   * of `getPolicies()` because column privileges are per-model, not
   * per-(model, dbRole). Emitter consumes this.
   */
  getColumnPrivileges(): readonly ColumnPrivilegeAst[] {
    return Object.freeze(
      [...this._modelBuilders.values()]
        .map((b) => b._toColumnPrivilegeAst())
        .filter((ast): ast is ColumnPrivilegeAst => ast !== undefined)
    )
  }

  /**
   * Deeply-frozen snapshot of every `noPolicy()` declaration. Lint extension
   * uses this to satisfy coverage without authoring real policies for tables
   * that don't need them.
   */
  getNoPolicies(): readonly NoPolicyAst[] {
    return Object.freeze([...this._noPolicies.values()])
  }

  /**
   * Begin authoring against a polymorphic model — one Prisma model whose
   * rows fan out to multiple physical target models via a discriminator
   * column. Repeated calls with the same `modelName` return the same
   * `PolymorphicBuilder`. Mutually exclusive with `.model()` and
   * `.noPolicy()` on the same name.
   *
   * See `./polymorphic.ts` for the per-target authoring API.
   */
  polymorphic(
    modelName: string,
    opts: { discriminator: string }
  ): PolymorphicBuilder<TClaimsShape, TDbRoles, TGrantTableKeys, TFunctions, TModels> {
    if (modelName.length === 0) {
      throw new Error('[prisma-guarddog] Guarddog.polymorphic(): modelName must be a non-empty string.')
    }
    if (opts.discriminator.length === 0) {
      throw new Error(
        `[prisma-guarddog] Guarddog.polymorphic("${modelName}"): discriminator must be a non-empty string.`
      )
    }
    if (this._modelBuilders.has(modelName)) {
      throw new Error(
        `[prisma-guarddog] Guarddog.polymorphic("${modelName}"): this model was previously declared via .model(). ` +
          'Use either .model() or .polymorphic() for a given Prisma model, not both.'
      )
    }
    if (this._noPolicies.has(modelName)) {
      throw new Error(
        `[prisma-guarddog] Guarddog.polymorphic("${modelName}"): this model was previously declared as noPolicy(). ` +
          'Remove the noPolicy() call if you want to declare a polymorphic policy.'
      )
    }
    const existing = this._polymorphics.get(modelName)
    if (existing !== undefined) {
      if (existing.discriminator !== opts.discriminator) {
        throw new Error(
          `[prisma-guarddog] Guarddog.polymorphic("${modelName}"): previously declared with ` +
            `discriminator="${existing.discriminator}", now redeclared with discriminator="${opts.discriminator}". ` +
            'Use a consistent discriminator across all calls.'
        )
      }
      return existing
    }
    const builder = new PolymorphicBuilder<TClaimsShape, TDbRoles, TGrantTableKeys, TFunctions, TModels>(
      this as unknown as {
        _buildPredicate<TCols extends string = string>(): PredicateBuilder<
          InferClaims<ClaimsDefinition<TClaimsShape>>,
          TGrantTableKeys,
          TFunctions,
          TCols
        >
      },
      modelName,
      opts.discriminator
    )
    this._polymorphics.set(modelName, builder)
    return builder
  }

  /**
   * Deeply-frozen snapshot of every polymorphic declaration. Emitter
   * walks each target inside and produces a per-(target, dbRole, verb)
   * Postgres policy with the discriminator equality auto-prepended.
   */
  getPolymorphics(): readonly PolymorphicAst[] {
    return Object.freeze([...this._polymorphics.values()].map((b) => b._toAst()))
  }
}

export class ModelBuilder<
  TClaimsShape extends ClaimsShape,
  TDbRoles extends string,
  TGrantTableKeys extends string = string,
  TFunctions extends Record<string, FunctionDefinition> = Record<string, FunctionDefinition>,
  TColumns extends string = string,
> {
  private _table: string | undefined
  private _columnPrivileges = new Map<string, ColumnPrivilegeGrant>()

  constructor(
    private readonly _guard: Guarddog<TClaimsShape, TDbRoles, string, string, string, TGrantTableKeys, TFunctions>,
    readonly modelName: string
  ) {}

  /**
   * Override the table name. Without this, the emitter relies on its
   * Prisma-name -> table-name resolver (typically snake_case + pluralization).
   */
  table(name: string): this {
    if (name.length === 0) {
      throw new Error('[prisma-guarddog] ModelBuilder.table(): name must be a non-empty string.')
    }
    this._table = name
    return this
  }

  /**
   * Declare per-column, per-verb privilege grants. Static and role-based —
   * does NOT do row-conditional field visibility (that's `.masks()` /
   * `.projection()`, deferred to Phase 2 per ADR-0004).
   *
   *   guard.model('Workbench').columnPrivileges({
   *     apiKey: { select: ['app_system'], update: ['app_system'] },
   *     internalNotes: { select: ['app_system', 'app_admin'] },
   *   });
   *
   * Repeated calls merge by column: the same column declared in two calls
   * has its verb-arrays unioned. Different columns in different calls
   * accumulate. This lets multiple files contribute column rules for the
   * same model without trampling.
   */
  columnPrivileges(
    spec: Record<
      string,
      {
        select?: ReadonlyArray<TDbRoles>
        insert?: ReadonlyArray<TDbRoles>
        update?: ReadonlyArray<TDbRoles>
      }
    >
  ): this {
    for (const [columnName, grant] of Object.entries(spec)) {
      if (columnName.length === 0) {
        throw new Error(
          `[prisma-guarddog] ModelBuilder("${this.modelName}").columnPrivileges(): column name must be a non-empty string.`
        )
      }
      const prior = this._columnPrivileges.get(columnName)
      const merged: ColumnPrivilegeGrant = Object.freeze({
        select: Object.freeze(mergeUnique(prior?.select, grant.select)),
        insert: Object.freeze(mergeUnique(prior?.insert, grant.insert)),
        update: Object.freeze(mergeUnique(prior?.update, grant.update)),
      })
      this._columnPrivileges.set(columnName, merged)
    }
    return this
  }

  /**
   * @internal — produces the per-model ColumnPrivilegeAst, or undefined if no
   * column rules were declared.
   */
  _toColumnPrivilegeAst(): ColumnPrivilegeAst | undefined {
    if (this._columnPrivileges.size === 0) return undefined
    const columns: Record<string, ColumnPrivilegeGrant> = {}
    for (const [col, grant] of this._columnPrivileges) {
      columns[col] = grant
    }
    return Object.freeze({
      model: this.modelName,
      table: this._table,
      columns: Object.freeze(columns),
    })
  }

  /**
   * Declare a restrictive policy for a specific Postgres role (ADR-0032 +
   * ADR-0033). The `.forAll(fn)` predicate is AND'd with every permissive
   * policy on this table — an inescapable floor.
   *
   * `slot` (default `'default'`, ADR-0033) addresses multiple restrictive
   * invariants on the same `(model, dbRole)`: each slot has its own
   * `RestrictivePolicyBuilder`. Calls with the same `(dbRole, slot)` return
   * the same builder (idempotent within a slot); different slots are
   * independent.
   *
   * Auto-name when no `.named(...)` override is set:
   *
   *   - slot omitted / `'default'`  →  `<table>_<role>_all`  *(alpha.14 preserved)*
   *   - slot provided               →  `<table>_<role>_<slot>`
   *
   * Prefer `.isolation(fn)` for the canonical tenant floor; this primitive
   * is the escape hatch for non-PUBLIC roles or named-slot composition.
   */
  restrictivePolicy(
    dbRole: TDbRoles | 'public',
    slot?: string
  ): RestrictivePolicyBuilder<TClaimsShape, TDbRoles, TGrantTableKeys, TFunctions, TColumns> {
    if ((dbRole as string).length === 0) {
      throw new Error('[prisma-guarddog] ModelBuilder.restrictivePolicy(): dbRole must be a non-empty string.')
    }
    if (slot !== undefined && slot.length === 0) {
      throw new Error(
        '[prisma-guarddog] ModelBuilder.restrictivePolicy(): slot must be a non-empty string when provided.'
      )
    }
    const resolvedSlot = slot ?? DEFAULT_RESTRICTIVE_SLOT
    const key = restrictiveKey(this.modelName, dbRole as string, resolvedSlot)
    const existing = this._guard._findRestrictivePolicy(key)
    if (existing !== undefined) {
      return existing as unknown as RestrictivePolicyBuilder<
        TClaimsShape,
        TDbRoles,
        TGrantTableKeys,
        TFunctions,
        TColumns
      >
    }
    const builder = new RestrictivePolicyBuilder<TClaimsShape, TDbRoles, TGrantTableKeys, TFunctions, TColumns>(
      this._guard,
      this.modelName,
      dbRole as TDbRoles,
      resolvedSlot,
      () => this._table
    )
    this._guard._registerRestrictivePolicy(
      key,
      builder as unknown as RestrictivePolicyBuilder<TClaimsShape, TDbRoles, TGrantTableKeys, TFunctions>
    )
    return builder
  }

  /**
   * Domain-aware sugar for tenant + soft-delete isolation floors (ADR-0032 +
   * ADR-0033). Desugars to `.restrictivePolicy('public', slot).forAll(fn)`
   * with the auto-name `<table>_isolation` (no slot) or `<table>_<slot>`
   * (when a slot is given). Returns `this` (the ModelBuilder) so the chain
   * can continue into permissive `.policy(role)` calls.
   *
   *   guard.model('Workspace').table('workspaces')
   *     .isolation((p) => p.claim('tenantId').eq(col('tenant_id')))             // <table>_isolation
   *     .isolation('no_soft_deleted', (p) => p.raw('deleted_at IS NULL'))       // <table>_no_soft_deleted
   *     .policy('app_user').select((p) => /* access only *\/)
   *
   * `opts.name` overrides the auto-name (legacy-name parity, ADR-0031).
   * Repeated calls with the same slot overwrite the predicate (the underlying
   * RestrictivePolicyBuilder is the same instance for that slot).
   */
  isolation(
    fn: PredicateFn<InferClaims<ClaimsDefinition<TClaimsShape>>, TGrantTableKeys, TFunctions, TColumns>,
    opts?: { readonly name?: string }
  ): this
  isolation(
    slot: string,
    fn: PredicateFn<InferClaims<ClaimsDefinition<TClaimsShape>>, TGrantTableKeys, TFunctions, TColumns>,
    opts?: { readonly name?: string }
  ): this
  isolation(
    slotOrFn: string | PredicateFn<InferClaims<ClaimsDefinition<TClaimsShape>>, TGrantTableKeys, TFunctions, TColumns>,
    fnOrOpts?:
      | PredicateFn<InferClaims<ClaimsDefinition<TClaimsShape>>, TGrantTableKeys, TFunctions, TColumns>
      | { readonly name?: string },
    maybeOpts?: { readonly name?: string }
  ): this {
    let slot: string | undefined
    let fn: PredicateFn<InferClaims<ClaimsDefinition<TClaimsShape>>, TGrantTableKeys, TFunctions, TColumns>
    let opts: { readonly name?: string } | undefined
    if (typeof slotOrFn === 'string') {
      slot = slotOrFn
      fn = fnOrOpts as PredicateFn<InferClaims<ClaimsDefinition<TClaimsShape>>, TGrantTableKeys, TFunctions, TColumns>
      opts = maybeOpts
    } else {
      fn = slotOrFn
      opts = fnOrOpts as { readonly name?: string } | undefined
    }
    this.restrictivePolicy('public', slot)._markIsolation().forAll(fn, opts)
    return this
  }

  /**
   * Begin authoring a policy for a specific Postgres role. Repeated calls
   * with the same `dbRole` return the same `PolicyBuilder`.
   */
  policy(dbRole: TDbRoles): PolicyBuilder<TClaimsShape, TDbRoles, TGrantTableKeys, TFunctions, TColumns> {
    if ((dbRole as string).length === 0) {
      throw new Error('[prisma-guarddog] ModelBuilder.policy(): dbRole must be a non-empty string.')
    }
    const key = policyKey(this.modelName, dbRole)
    const existing = this._guard._findPolicy(key)
    // The policy registry is keyed loosely (string columns); the precise
    // column union rides on the return type only (ADR-0028). Runtime identical.
    if (existing !== undefined) {
      return existing as unknown as PolicyBuilder<TClaimsShape, TDbRoles, TGrantTableKeys, TFunctions, TColumns>
    }
    const builder = new PolicyBuilder<TClaimsShape, TDbRoles, TGrantTableKeys, TFunctions, TColumns>(
      this._guard,
      this.modelName,
      dbRole,
      () => this._table
    )
    this._guard._registerPolicy(
      key,
      builder as unknown as PolicyBuilder<TClaimsShape, TDbRoles, TGrantTableKeys, TFunctions>
    )
    return builder
  }
}

export class PolicyBuilder<
  TClaimsShape extends ClaimsShape,
  TDbRoles extends string,
  TGrantTableKeys extends string = string,
  TFunctions extends Record<string, FunctionDefinition> = Record<string, FunctionDefinition>,
  TColumns extends string = string,
> {
  private _select: SelectSpec | undefined
  private _insert: InsertSpec | undefined
  private _update: UpdateSpec | undefined
  private _delete: DeleteSpec | undefined
  private readonly _todos: string[] = []
  // Chained name override (ADR-0031): persists across subsequent verb calls
  // until `.named(undefined)` clears it or a fresh `.policy()` returns a new
  // builder. Per-verb `{ name }` wins over this when both are set.
  private _declaredName: string | undefined = undefined

  constructor(
    private readonly _guard: Guarddog<TClaimsShape, TDbRoles, string, string, string, TGrantTableKeys, TFunctions>,
    readonly modelName: string,
    readonly dbRole: TDbRoles,
    private readonly _getTable: () => string | undefined
  ) {}

  /**
   * Override the auto-generated policy name for every subsequent verb on this
   * builder (ADR-0031). Opt-in escape hatch for transitional adoption: a typed
   * replacement under a legacy name renders `DROP POLICY IF EXISTS <legacy>;
   * CREATE POLICY <legacy> …`, upgrading the legacy policy in place with no
   * widening window. Pass `undefined` to clear; a per-verb `{ name }` wins.
   * Lint warns whenever any verb spec carries a declared name.
   */
  named(name: string | undefined): this {
    if (name !== undefined && name.length === 0) {
      throw new Error('[prisma-guarddog] PolicyBuilder.named(): name must be a non-empty string or undefined.')
    }
    this._declaredName = name
    return this
  }

  /**
   * Define the `USING` predicate for SELECT. Re-calling overwrites the prior
   * definition for this verb. `opts.name` overrides the auto-generated policy
   * name for this verb (ADR-0031).
   */
  select(
    fn: PredicateFn<InferClaims<ClaimsDefinition<TClaimsShape>>, TGrantTableKeys, TFunctions, TColumns>,
    opts?: { readonly name?: string }
  ): this {
    const using = freezeExprDeep(fn(this._guard._buildPredicate<TColumns>()).ast)
    this._select = Object.freeze({ using, ...this._resolveNameField(opts?.name) })
    return this
  }

  /**
   * Define the `WITH CHECK` predicate for INSERT. INSERT has no `USING` —
   * Postgres uses the CHECK clause to evaluate new rows. ADR-0005. `spec.name`
   * overrides the auto-generated policy name (ADR-0031).
   */
  insert(spec: {
    check: PredicateFn<InferClaims<ClaimsDefinition<TClaimsShape>>, TGrantTableKeys, TFunctions, TColumns>
    readonly name?: string
  }): this {
    const check = freezeExprDeep(spec.check(this._guard._buildPredicate<TColumns>()).ast)
    this._insert = Object.freeze({ check, ...this._resolveNameField(spec.name) })
    return this
  }

  /**
   * Define BOTH `USING` (eligibility) and `WITH CHECK` (post-update shape)
   * for UPDATE. Both are mandatory and never inferred from each other.
   * ADR-0005. `spec.name` overrides the auto-generated policy name (ADR-0031).
   */
  update(spec: {
    using: PredicateFn<InferClaims<ClaimsDefinition<TClaimsShape>>, TGrantTableKeys, TFunctions, TColumns>
    check: PredicateFn<InferClaims<ClaimsDefinition<TClaimsShape>>, TGrantTableKeys, TFunctions, TColumns>
    readonly name?: string
  }): this {
    const p = this._guard._buildPredicate<TColumns>()
    this._update = Object.freeze({
      using: freezeExprDeep(spec.using(p).ast),
      check: freezeExprDeep(spec.check(p).ast),
      ...this._resolveNameField(spec.name),
    })
    return this
  }

  /** Define the `USING` predicate for DELETE. `spec.name` overrides the auto-gen name (ADR-0031). */
  delete(spec: {
    using: PredicateFn<InferClaims<ClaimsDefinition<TClaimsShape>>, TGrantTableKeys, TFunctions, TColumns>
    readonly name?: string
  }): this {
    const using = freezeExprDeep(spec.using(this._guard._buildPredicate<TColumns>()).ast)
    this._delete = Object.freeze({ using, ...this._resolveNameField(spec.name) })
    return this
  }

  /**
   * Resolve the declared name for one verb spec. Per-verb override wins over
   * the chained `.named()`; both must be non-empty if set. Returns a sparse
   * `{ name }` object so the AST stays clean when nothing is declared.
   */
  private _resolveNameField(perVerb: string | undefined): { readonly name?: string } {
    const name = perVerb ?? this._declaredName
    if (name === undefined) return {}
    if (name.length === 0) {
      throw new Error(
        `[prisma-guarddog] PolicyBuilder("${this.modelName}::${this.dbRole}"): policy name must be a non-empty string.`
      )
    }
    return { name }
  }

  /**
   * Drop a raw-SQL string in as the entire predicate for one verb. Primarily
   * used by the scaffold importer (see ADR-0012) to wrap existing
   * hand-written policies as `Expr.raw` while preserving coverage. Also
   * available to hand-tune to during migration.
   *
   * UPDATE rawSql uses the same SQL for both USING and WITH CHECK; if the
   * two clauses must differ, call `.update({ using, check })` with
   * `p.raw(...)` inside each predicate function instead.
   */
  rawSql(verb: Verb, sql: string): this {
    if (sql.length === 0) {
      throw new Error(
        `[prisma-guarddog] PolicyBuilder("${this.modelName}::${this.dbRole}").rawSql("${verb}"): sql must be a non-empty string.`
      )
    }
    const rawExpr: Expr = Object.freeze({ kind: 'raw', sql })
    switch (verb) {
      case 'select':
        this._select = Object.freeze({ using: rawExpr })
        break
      case 'insert':
        this._insert = Object.freeze({ check: rawExpr })
        break
      case 'update':
        this._update = Object.freeze({ using: rawExpr, check: rawExpr })
        break
      case 'delete':
        this._delete = Object.freeze({ using: rawExpr })
        break
    }
    return this
  }

  /**
   * Attach a TODO marker to this policy. Emits as a SQL comment on the
   * generated migration and is flagged by the lint extension as
   * work-in-progress. Used by the scaffold importer to mark "replace raw
   * SQL with typed predicates" and similar follow-ups.
   */
  todo(message: string): this {
    if (message.length === 0) {
      throw new Error(
        `[prisma-guarddog] PolicyBuilder("${this.modelName}::${this.dbRole}").todo(): message must be a non-empty string.`
      )
    }
    this._todos.push(message)
    return this
  }

  /**
   * @internal — emit the immutable AST for this policy. Called by
   * `Guarddog.getPolicies()`.
   */
  _toAst(): PolicyAst {
    return Object.freeze({
      model: this.modelName,
      dbRole: this.dbRole,
      table: this._getTable(),
      select: this._select,
      insert: this._insert,
      update: this._update,
      delete: this._delete,
      all: undefined,
      todos: Object.freeze([...this._todos]),
    })
  }
}

/**
 * Builder for a single restrictive policy (ADR-0032 + ADR-0033). One per
 * `(model, dbRole, slot)` — the registry enforces idempotence within a slot,
 * so `.restrictivePolicy('public', 'boundary')` twice on the same model
 * returns the same builder, while different slots get independent builders.
 *
 * Restrictive policies declare exactly one predicate via `.forAll()`. That
 * predicate is AND'd with every other policy on the table — the inescapable
 * floor. The sister sugar `.isolation()` (on `ModelBuilder`) sets `_isolation`
 * so the auto-name resolves to `<table>_isolation` (no slot) or
 * `<table>_<slot>` (with slot) instead of the generic low-level form.
 */
export class RestrictivePolicyBuilder<
  TClaimsShape extends ClaimsShape,
  TDbRoles extends string,
  TGrantTableKeys extends string = string,
  TFunctions extends Record<string, FunctionDefinition> = Record<string, FunctionDefinition>,
  TColumns extends string = string,
> {
  private _all: AllSpec | undefined
  private _isolation = false
  private _declaredName: string | undefined = undefined
  private readonly _todos: string[] = []

  constructor(
    private readonly _guard: Guarddog<TClaimsShape, TDbRoles, string, string, string, TGrantTableKeys, TFunctions>,
    readonly modelName: string,
    readonly dbRole: TDbRoles,
    readonly slot: string,
    private readonly _getTable: () => string | undefined
  ) {}

  /**
   * Override the auto-generated policy name. Same semantics as
   * `PolicyBuilder.named()` (ADR-0031): persists for the `.forAll(...)`
   * declaration that follows. A per-call `{ name }` on `.forAll()` wins.
   */
  named(name: string | undefined): this {
    if (name !== undefined && name.length === 0) {
      throw new Error(
        '[prisma-guarddog] RestrictivePolicyBuilder.named(): name must be a non-empty string or undefined.'
      )
    }
    this._declaredName = name
    return this
  }

  /**
   * Declare the `FOR ALL` predicate (ADR-0032). The same predicate becomes
   * both the `USING` and `WITH CHECK` of the emitted restrictive policy, so
   * SELECT, INSERT, UPDATE, and DELETE all pass through it.
   */
  forAll(
    fn: PredicateFn<InferClaims<ClaimsDefinition<TClaimsShape>>, TGrantTableKeys, TFunctions, TColumns>,
    opts?: { readonly name?: string }
  ): this {
    const expr = freezeExprDeep(fn(this._guard._buildPredicate<TColumns>()).ast)
    this._all = Object.freeze({ using: expr, check: expr, ...this._resolveNameField(opts?.name) })
    return this
  }

  /**
   * Attach a TODO marker to this restrictive policy. Same semantics as
   * `PolicyBuilder.todo()`.
   */
  todo(message: string): this {
    if (message.length === 0) {
      throw new Error(
        `[prisma-guarddog] RestrictivePolicyBuilder("${this.modelName}::${this.dbRole}").todo(): message must be a non-empty string.`
      )
    }
    this._todos.push(message)
    return this
  }

  /** @internal — marks this restrictive as authored via `.isolation()` so the lifecycle picks `<table>_isolation`. */
  _markIsolation(): this {
    this._isolation = true
    return this
  }

  private _resolveNameField(perCall: string | undefined): { readonly name?: string } {
    const name = perCall ?? this._declaredName
    if (name === undefined) return {}
    if (name.length === 0) {
      throw new Error(
        `[prisma-guarddog] RestrictivePolicyBuilder("${this.modelName}::${this.dbRole}"): policy name must be a non-empty string.`
      )
    }
    return { name }
  }

  /**
   * @internal — emit the immutable AST for this restrictive policy. Called by
   * `Guarddog.getPolicies()`.
   */
  _toAst(): PolicyAst {
    return Object.freeze({
      model: this.modelName,
      dbRole: this.dbRole,
      table: this._getTable(),
      select: undefined,
      insert: undefined,
      update: undefined,
      delete: undefined,
      all: this._all,
      restrictive: true,
      isolation: this._isolation,
      slot: this.slot,
      todos: Object.freeze([...this._todos]),
    })
  }
}

function policyKey(model: string, dbRole: string): string {
  return `${model}::${dbRole}`
}

/**
 * Default slot key for restrictive policies (ADR-0033). Calls without an
 * explicit slot hit this key, preserving the alpha.14 singleton behavior.
 */
export const DEFAULT_RESTRICTIVE_SLOT = 'default'

function restrictiveKey(model: string, dbRole: string, slot: string): string {
  return `${model}::${dbRole}::${slot}`
}

function mergeUnique<T extends string>(prior: ReadonlyArray<T> | undefined, next: ReadonlyArray<T> | undefined): T[] {
  const seen = new Set<T>(prior ?? [])
  if (next !== undefined) {
    for (const item of next) seen.add(item)
  }
  return [...seen]
}

function freezeExprDeep(expr: Expr): Expr {
  // Each builder helper already freezes its node; defensive deep walk catches
  // any future builder that forgets. Frozen objects are safe to walk repeatedly.
  switch (expr.kind) {
    case 'literal':
    case 'col':
    case 'claim':
    case 'hasAppRole':
    case 'hasGrant':
    case 'hasResourcePermission':
    case 'isOwner':
    case 'raw':
      return Object.freeze(expr) as Expr
    case 'binop':
      return Object.freeze({
        kind: 'binop',
        op: expr.op,
        left: freezeExprDeep(expr.left),
        right: freezeExprDeep(expr.right),
      }) as Expr
    case 'and':
    case 'or':
      return Object.freeze({
        kind: expr.kind,
        operands: Object.freeze(expr.operands.map(freezeExprDeep)),
      }) as Expr
    case 'not':
      return Object.freeze({ kind: 'not', operand: freezeExprDeep(expr.operand) }) as Expr
    case 'inArray':
      return Object.freeze({
        kind: 'inArray',
        needle: freezeExprDeep(expr.needle),
        haystack: freezeExprDeep(expr.haystack),
      }) as Expr
    case 'fn':
      return Object.freeze({
        kind: 'fn',
        name: expr.name,
        args: Object.freeze(expr.args.map(freezeExprDeep)),
      }) as Expr
  }
}
