/**
 * `Guarddog` — the policy registry and orchestrator.
 *
 * Authoring flow:
 *
 *     const guard = new Guarddog({
 *       claims:        defineClaims({ ... }),
 *       dbRoles:       defineDbRoles({ ... }),
 *       businessRoles: defineBusinessRoles({ ... }),
 *       resources:     defineResources({ ... }),
 *     });
 *
 *     guard.model('Workbench')
 *       .policy('app_user')
 *       .select(p => p.claim('tenantId').eq(col('tenantId'))
 *                     .and(p.hasRole('workspace.admin', col('workspaceId'))))
 *       .insert({ check: p => p.hasRole('workspace.editor', col('workspaceId')) })
 *       .update({
 *         using: p => p.isOwner(col('ownerId')),
 *         check: p => p.hasRole('workspace.admin', col('workspaceId')),
 *       })
 *       .delete({ using: p => p.hasRole('workspace.admin', col('workspaceId')) });
 *
 * `.policy()` always returns the same `PolicyBuilder` instance for a given
 * (model, dbRole) pair within a Guarddog — repeated `.policy('app_user')` on
 * the same model is idempotent, so split authoring across files is safe.
 *
 * Snapshots: `guard.getPolicies()` returns a deeply-frozen `PolicyAst[]` for
 * emitter consumption. The Guarddog instance can keep being mutated after a
 * snapshot — new snapshots reflect the latest state.
 */

import type {
  ColumnPrivilegeAst,
  ColumnPrivilegeGrant,
  DeleteSpec,
  Expr,
  InsertSpec,
  NoPolicyAst,
  PolicyAst,
  SelectSpec,
  UpdateSpec,
  Verb,
} from './ast.js'
import type { BusinessRolesDefinition } from './business-roles.js'
import type { ClaimsDefinition, ClaimsShape, InferClaims } from './claims.js'
import type { DbRolesDefinition } from './db-roles.js'
import { FluentExpr, PredicateBuilder } from './predicate.js'
import type { ResourceTreeDefinition } from './resources.js'

export interface GuarddogConfig<
  TClaimsShape extends ClaimsShape,
  TDbRoles extends string,
  TBusinessRoles extends string,
  TResources extends string,
> {
  readonly claims: ClaimsDefinition<TClaimsShape>
  readonly dbRoles: DbRolesDefinition<TDbRoles>
  readonly businessRoles: BusinessRolesDefinition<TBusinessRoles>
  readonly resources: ResourceTreeDefinition<TResources>
}

type PredicateFn<TClaims> = (p: PredicateBuilder<TClaims>) => FluentExpr

export class Guarddog<
  TClaimsShape extends ClaimsShape = ClaimsShape,
  TDbRoles extends string = string,
  TBusinessRoles extends string = string,
  TResources extends string = string,
> {
  readonly config: GuarddogConfig<TClaimsShape, TDbRoles, TBusinessRoles, TResources>
  private readonly _modelBuilders = new Map<string, ModelBuilder<TClaimsShape, TDbRoles>>()
  private readonly _policies = new Map<string, PolicyBuilder<TClaimsShape, TDbRoles>>()
  private readonly _noPolicies = new Map<string, NoPolicyAst>()

  constructor(config: GuarddogConfig<TClaimsShape, TDbRoles, TBusinessRoles, TResources>) {
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
    this._noPolicies.set(modelName, Object.freeze({ model: modelName, reason: opts.reason }))
    return this
  }

  /**
   * Begin authoring against a Prisma model. Repeated calls with the same
   * `modelName` return the same `ModelBuilder` so multi-file authoring is
   * idempotent.
   */
  model(modelName: string): ModelBuilder<TClaimsShape, TDbRoles> {
    if (modelName.length === 0) {
      throw new Error('[prisma-guarddog] Guarddog.model(): modelName must be a non-empty string.')
    }
    if (this._noPolicies.has(modelName)) {
      throw new Error(
        `[prisma-guarddog] Guarddog.model("${modelName}"): this model was previously declared as noPolicy(). ` +
          'Remove the noPolicy() call if you want to declare a policy.'
      )
    }
    let builder = this._modelBuilders.get(modelName)
    if (builder === undefined) {
      builder = new ModelBuilder<TClaimsShape, TDbRoles>(this, modelName)
      this._modelBuilders.set(modelName, builder)
    }
    return builder
  }

  /**
   * @internal — called by PolicyBuilder during construction. Public consumers
   * should not call this directly.
   */
  _registerPolicy(key: string, builder: PolicyBuilder<TClaimsShape, TDbRoles>): void {
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
  _findPolicy(key: string): PolicyBuilder<TClaimsShape, TDbRoles> | undefined {
    return this._policies.get(key)
  }

  /** Construct the predicate builder threaded with the registered claim shape. */
  _buildPredicate(): PredicateBuilder<InferClaims<ClaimsDefinition<TClaimsShape>>> {
    return new PredicateBuilder<InferClaims<ClaimsDefinition<TClaimsShape>>>()
  }

  /**
   * Deeply-frozen snapshot of every policy declared so far. Stable: insertion
   * order across multiple calls. Emitter consumes this.
   */
  getPolicies(): readonly PolicyAst[] {
    return Object.freeze([...this._policies.values()].map((b) => b._toAst()))
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
}

export class ModelBuilder<TClaimsShape extends ClaimsShape, TDbRoles extends string> {
  private _table: string | undefined
  private _columnPrivileges = new Map<string, ColumnPrivilegeGrant>()

  constructor(
    private readonly _guard: Guarddog<TClaimsShape, TDbRoles>,
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
   * Begin authoring a policy for a specific Postgres role. Repeated calls
   * with the same `dbRole` return the same `PolicyBuilder`.
   */
  policy(dbRole: TDbRoles): PolicyBuilder<TClaimsShape, TDbRoles> {
    if ((dbRole as string).length === 0) {
      throw new Error('[prisma-guarddog] ModelBuilder.policy(): dbRole must be a non-empty string.')
    }
    const key = policyKey(this.modelName, dbRole)
    const existing = this._guard._findPolicy(key)
    if (existing !== undefined) return existing
    const builder = new PolicyBuilder<TClaimsShape, TDbRoles>(this._guard, this.modelName, dbRole, () => this._table)
    this._guard._registerPolicy(key, builder)
    return builder
  }
}

export class PolicyBuilder<TClaimsShape extends ClaimsShape, TDbRoles extends string> {
  private _select: SelectSpec | undefined
  private _insert: InsertSpec | undefined
  private _update: UpdateSpec | undefined
  private _delete: DeleteSpec | undefined
  private readonly _todos: string[] = []

  constructor(
    private readonly _guard: Guarddog<TClaimsShape, TDbRoles>,
    readonly modelName: string,
    readonly dbRole: TDbRoles,
    private readonly _getTable: () => string | undefined
  ) {}

  /**
   * Define the `USING` predicate for SELECT. Re-calling overwrites the prior
   * definition for this verb.
   */
  select(fn: PredicateFn<InferClaims<ClaimsDefinition<TClaimsShape>>>): this {
    this._select = Object.freeze({ using: freezeExprDeep(fn(this._guard._buildPredicate()).ast) })
    return this
  }

  /**
   * Define the `WITH CHECK` predicate for INSERT. INSERT has no `USING` —
   * Postgres uses the CHECK clause to evaluate new rows. ADR-0005.
   */
  insert(spec: { check: PredicateFn<InferClaims<ClaimsDefinition<TClaimsShape>>> }): this {
    this._insert = Object.freeze({ check: freezeExprDeep(spec.check(this._guard._buildPredicate()).ast) })
    return this
  }

  /**
   * Define BOTH `USING` (eligibility) and `WITH CHECK` (post-update shape)
   * for UPDATE. Both are mandatory and never inferred from each other.
   * ADR-0005.
   */
  update(spec: {
    using: PredicateFn<InferClaims<ClaimsDefinition<TClaimsShape>>>
    check: PredicateFn<InferClaims<ClaimsDefinition<TClaimsShape>>>
  }): this {
    const p = this._guard._buildPredicate()
    this._update = Object.freeze({
      using: freezeExprDeep(spec.using(p).ast),
      check: freezeExprDeep(spec.check(p).ast),
    })
    return this
  }

  /** Define the `USING` predicate for DELETE. */
  delete(spec: { using: PredicateFn<InferClaims<ClaimsDefinition<TClaimsShape>>> }): this {
    this._delete = Object.freeze({ using: freezeExprDeep(spec.using(this._guard._buildPredicate()).ast) })
    return this
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
      todos: Object.freeze([...this._todos]),
    })
  }
}

function policyKey(model: string, dbRole: string): string {
  return `${model}::${dbRole}`
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
    case 'hasRole':
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
  }
}
