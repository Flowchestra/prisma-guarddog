/**
 * Polymorphic builder hierarchy.
 *
 * A polymorphic table is one Prisma model whose rows fan out to multiple
 * physical target models via a discriminator column. Authoring a policy
 * for it requires per-target predicates because access rules diverge by
 * target type — but the discriminator-equality check itself is mechanical
 * and shouldn't be hand-written in every predicate.
 *
 * Usage:
 *
 *     const poly = guard.polymorphic('ScopeTarget', { discriminator: 'targetType' });
 *
 *     poly.target('Workspace', { model: 'Workspace' })
 *       .policy('app_user')
 *       .select(p => p.claim('tenantId').eq(col('tenantId')))
 *       .insert({ check: p => p.hasGrant('workspace.admin', col('targetId')) });
 *
 *     poly.target('Workbench', { model: 'Workbench' })
 *       .policy('app_user')
 *       .select(p => p.hasGrant('workbench.editor', col('targetId')));
 *
 * At emit time each target produces a separate `CREATE POLICY` with the
 * discriminator equality prepended:
 *
 *     CREATE POLICY "scope_target_workspace_select" ON scope_targets
 *       FOR SELECT TO app_user
 *       USING (target_type = 'Workspace' AND <workspace-specific predicate>);
 *
 * Column references inside polymorphic-target policies resolve against the
 * polymorphic table's columns (not the target's). If you need to join
 * against the target model, use `p.raw('EXISTS (SELECT 1 FROM ... )')`.
 */

import type {
  DeleteSpec,
  Expr,
  InsertSpec,
  PolymorphicAst,
  PolymorphicTargetAst,
  PolymorphicTargetPolicyAst,
  SelectSpec,
  UpdateSpec,
  Verb,
} from './ast.js'
import type { ClaimsDefinition, ClaimsShape, InferClaims } from './claims.js'
import { FluentExpr, PredicateBuilder } from './predicate.js'

type PredicateFn<TClaims, TGrantTableKeys extends string = string> = (
  p: PredicateBuilder<TClaims, TGrantTableKeys>
) => FluentExpr

/**
 * Internal protocol: the polymorphic builder hierarchy calls back into the
 * Guarddog instance for the predicate builder factory only. Avoids a
 * circular import with guarddog.ts.
 */
export interface PolymorphicHost<TClaimsShape extends ClaimsShape, TGrantTableKeys extends string = string> {
  _buildPredicate(): PredicateBuilder<InferClaims<ClaimsDefinition<TClaimsShape>>, TGrantTableKeys>
}

export class PolymorphicBuilder<
  TClaimsShape extends ClaimsShape,
  TDbRoles extends string,
  TGrantTableKeys extends string = string,
> {
  private _table: string | undefined
  private readonly _targets = new Map<string, PolymorphicTargetBuilder<TClaimsShape, TDbRoles, TGrantTableKeys>>()

  constructor(
    private readonly _host: PolymorphicHost<TClaimsShape, TGrantTableKeys>,
    readonly modelName: string,
    readonly discriminator: string
  ) {}

  /**
   * Override the table name. Without this, the emitter relies on its
   * Prisma-name -> table-name resolver (typically snake_case).
   */
  table(name: string): this {
    if (name.length === 0) {
      throw new Error(
        `[prisma-guarddog] PolymorphicBuilder("${this.modelName}").table(): name must be a non-empty string.`
      )
    }
    this._table = name
    return this
  }

  /**
   * Declare (or re-fetch) a target for the polymorphic discriminator.
   * Repeated calls with the same `discriminatorValue` return the same builder
   * so split authoring is safe; the `model` option is enforced consistent on
   * re-fetch (mismatched targetModelName is a fail-fast bug).
   */
  target(
    discriminatorValue: string,
    opts: { model: string }
  ): PolymorphicTargetBuilder<TClaimsShape, TDbRoles, TGrantTableKeys> {
    if (discriminatorValue.length === 0) {
      throw new Error(
        `[prisma-guarddog] PolymorphicBuilder("${this.modelName}").target(): discriminatorValue must be a non-empty string.`
      )
    }
    if (opts.model.length === 0) {
      throw new Error(
        `[prisma-guarddog] PolymorphicBuilder("${this.modelName}").target("${discriminatorValue}"): model must be a non-empty string.`
      )
    }
    const existing = this._targets.get(discriminatorValue)
    if (existing !== undefined) {
      if (existing.targetModelName !== opts.model) {
        throw new Error(
          `[prisma-guarddog] PolymorphicBuilder("${this.modelName}").target("${discriminatorValue}"): ` +
            `previously declared with model="${existing.targetModelName}", now redeclared with model="${opts.model}". ` +
            'Use a consistent target model across all calls.'
        )
      }
      return existing
    }
    const builder = new PolymorphicTargetBuilder<TClaimsShape, TDbRoles, TGrantTableKeys>(
      this._host,
      discriminatorValue,
      opts.model
    )
    this._targets.set(discriminatorValue, builder)
    return builder
  }

  /** @internal — emit the immutable AST for this polymorphic declaration. */
  _toAst(): PolymorphicAst {
    return Object.freeze({
      modelName: this.modelName,
      table: this._table,
      discriminator: this.discriminator,
      targets: Object.freeze([...this._targets.values()].map((t) => t._toAst())),
    })
  }
}

export class PolymorphicTargetBuilder<
  TClaimsShape extends ClaimsShape,
  TDbRoles extends string,
  TGrantTableKeys extends string = string,
> {
  private readonly _policies = new Map<
    string,
    PolymorphicTargetPolicyBuilder<TClaimsShape, TDbRoles, TGrantTableKeys>
  >()

  constructor(
    private readonly _host: PolymorphicHost<TClaimsShape, TGrantTableKeys>,
    readonly discriminatorValue: string,
    readonly targetModelName: string
  ) {}

  /**
   * Begin authoring a policy for this target + dbRole. Idempotent — repeated
   * calls with the same dbRole return the same builder.
   */
  policy(dbRole: TDbRoles): PolymorphicTargetPolicyBuilder<TClaimsShape, TDbRoles, TGrantTableKeys> {
    if ((dbRole as string).length === 0) {
      throw new Error(
        `[prisma-guarddog] PolymorphicTargetBuilder("${this.discriminatorValue}").policy(): dbRole must be a non-empty string.`
      )
    }
    let builder = this._policies.get(dbRole as string)
    if (builder === undefined) {
      builder = new PolymorphicTargetPolicyBuilder<TClaimsShape, TDbRoles, TGrantTableKeys>(this._host, dbRole)
      this._policies.set(dbRole as string, builder)
    }
    return builder
  }

  /** @internal — emit the immutable AST for this target. */
  _toAst(): PolymorphicTargetAst {
    return Object.freeze({
      discriminatorValue: this.discriminatorValue,
      targetModelName: this.targetModelName,
      policies: Object.freeze([...this._policies.values()].map((p) => p._toAst())),
    })
  }
}

export class PolymorphicTargetPolicyBuilder<
  TClaimsShape extends ClaimsShape,
  TDbRoles extends string,
  TGrantTableKeys extends string = string,
> {
  private _select: SelectSpec | undefined
  private _insert: InsertSpec | undefined
  private _update: UpdateSpec | undefined
  private _delete: DeleteSpec | undefined
  private readonly _todos: string[] = []

  constructor(
    private readonly _host: PolymorphicHost<TClaimsShape, TGrantTableKeys>,
    readonly dbRole: TDbRoles
  ) {}

  /**
   * Define the `USING` predicate for SELECT. The emitter prepends
   * `<discriminator> = '<value>'` automatically; do not restate it.
   */
  select(fn: PredicateFn<InferClaims<ClaimsDefinition<TClaimsShape>>, TGrantTableKeys>): this {
    this._select = Object.freeze({ using: freezeExprDeep(fn(this._host._buildPredicate()).ast) })
    return this
  }

  /** Define the `WITH CHECK` predicate for INSERT. ADR-0005. */
  insert(spec: { check: PredicateFn<InferClaims<ClaimsDefinition<TClaimsShape>>, TGrantTableKeys> }): this {
    this._insert = Object.freeze({
      check: freezeExprDeep(spec.check(this._host._buildPredicate()).ast),
    })
    return this
  }

  /**
   * Define BOTH `USING` (eligibility) and `WITH CHECK` (post-update shape)
   * for UPDATE. Both are mandatory. ADR-0005.
   */
  update(spec: {
    using: PredicateFn<InferClaims<ClaimsDefinition<TClaimsShape>>, TGrantTableKeys>
    check: PredicateFn<InferClaims<ClaimsDefinition<TClaimsShape>>, TGrantTableKeys>
  }): this {
    const p = this._host._buildPredicate()
    this._update = Object.freeze({
      using: freezeExprDeep(spec.using(p).ast),
      check: freezeExprDeep(spec.check(p).ast),
    })
    return this
  }

  /** Define the `USING` predicate for DELETE. */
  delete(spec: { using: PredicateFn<InferClaims<ClaimsDefinition<TClaimsShape>>, TGrantTableKeys> }): this {
    this._delete = Object.freeze({
      using: freezeExprDeep(spec.using(this._host._buildPredicate()).ast),
    })
    return this
  }

  /**
   * Drop a raw-SQL string in as the entire predicate for one verb. Used by
   * the scaffold importer to wrap existing hand-written policies that
   * weren't authored against this DSL. ADR-0012.
   */
  rawSql(verb: Verb, sql: string): this {
    if (sql.length === 0) {
      throw new Error(
        `[prisma-guarddog] PolymorphicTargetPolicyBuilder.rawSql("${verb}"): sql must be a non-empty string.`
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

  /** Attach a TODO marker — emits as a SQL comment; lint flags as WIP. */
  todo(message: string): this {
    if (message.length === 0) {
      throw new Error(`[prisma-guarddog] PolymorphicTargetPolicyBuilder.todo(): message must be a non-empty string.`)
    }
    this._todos.push(message)
    return this
  }

  /** @internal — emit the immutable AST for this (target, dbRole) policy. */
  _toAst(): PolymorphicTargetPolicyAst {
    return Object.freeze({
      dbRole: this.dbRole,
      select: this._select,
      insert: this._insert,
      update: this._update,
      delete: this._delete,
      todos: Object.freeze([...this._todos]),
    })
  }
}

/**
 * Deeply-freeze an Expr tree. Duplicated from guarddog.ts to avoid a
 * circular import; small enough that the duplication is cheaper than
 * extracting into a shared module.
 */
function freezeExprDeep(expr: Expr): Expr {
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
  }
}
