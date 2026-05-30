/**
 * AST types — the typed-value representation of a policy that emitters,
 * importers, and the diff engine all consume. Pure data; no methods,
 * no closures, no I/O.
 *
 * AST is FROZEN once produced. Builders mutate their own internal state
 * while authoring; once a policy is realized via `Guarddog.getPolicies()`,
 * the returned tree is deeply frozen.
 */

export type LiteralValue = string | number | boolean | null

export type BinaryOp = 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte'

export type Verb = 'select' | 'insert' | 'update' | 'delete' | 'all'

/**
 * Expression AST. Predicates inside USING and WITH CHECK clauses produce
 * an `Expr` tree. The emitter walks the tree and renders SQL.
 *
 * The three permission-layer helpers — `hasAppRole`, `hasGrant`,
 * `hasResourcePermission` — are high-level forms that the emitter expands
 * into inline jsonb claim / column lookups. Each maps to exactly one of the
 * three permission layers (appRoles, resourceGrants, per-resource jsonb).
 *
 * `isOwner` and `inArray` are convenience predicates that compile to
 * deterministic SQL fragments.
 *
 * `raw` is the explicit escape hatch — content is emitted verbatim.
 */
export type Expr =
  | { readonly kind: 'literal'; readonly value: LiteralValue }
  | { readonly kind: 'col'; readonly column: string }
  | { readonly kind: 'claim'; readonly path: string }
  | { readonly kind: 'binop'; readonly op: BinaryOp; readonly left: Expr; readonly right: Expr }
  | { readonly kind: 'and'; readonly operands: ReadonlyArray<Expr> }
  | { readonly kind: 'or'; readonly operands: ReadonlyArray<Expr> }
  | { readonly kind: 'not'; readonly operand: Expr }
  /** Layer 2 (appRoles): "does the requesting user hold `<role>` globally?" */
  | { readonly kind: 'hasAppRole'; readonly role: string }
  /**
   * Layer 3 (resourceGrants): "does the requesting user have `<action>` on
   * the resource identified by `<scopeColumn>`?"
   */
  | {
      readonly kind: 'hasGrant'
      readonly action: string
      readonly scopeColumn: string
      /**
       * Optional `tables`-map key disambiguating which grant table to route
       * to, for `source: 'table'`. Needed when two policies check the same
       * scope column (e.g. own-row `col('id')`) against different grant
       * tables — global column-name keying can't express that. Ignored for
       * the claims source. See ADR-0025.
       */
      readonly tableHint?: string
    }
  /**
   * Per-resource jsonb permissions: "does the requesting user (or their
   * groups) have `<action>` in the `permissions` jsonb stored on this row?"
   */
  | { readonly kind: 'hasResourcePermission'; readonly action: string; readonly jsonbColumn: string }
  | { readonly kind: 'isOwner'; readonly ownerColumn: string }
  | { readonly kind: 'inArray'; readonly needle: Expr; readonly haystack: Expr }
  /**
   * Call to a guarddog-managed SQL function (ADR-0026). Compiles to
   * `<schema>.<name>(<compiled args>)`. `args` are already normalized to
   * Exprs (literals wrapped). The schema + name resolution happens at emit
   * time against the configured `defineFunctions`.
   */
  | { readonly kind: 'fn'; readonly name: string; readonly args: ReadonlyArray<Expr> }
  | { readonly kind: 'raw'; readonly sql: string }

/**
 * Per-verb policy specification. `USING` and `WITH CHECK` are explicit and
 * never inferred from one another (ADR-0005).
 *
 * Each spec carries an optional `name` overriding the auto-generated
 * `<table>_<role>_<command>` policy name (ADR-0031) — opt-in escape hatch for
 * transitional adoption so a typed replacement renders as
 * `DROP POLICY IF EXISTS <legacy>; CREATE POLICY <legacy> …` and upgrades the
 * legacy policy in place, atomically. Lint warns when set.
 */
export interface SelectSpec {
  readonly using: Expr
  readonly name?: string
}

export interface InsertSpec {
  readonly check: Expr
  readonly name?: string
}

export interface UpdateSpec {
  readonly using: Expr
  readonly check: Expr
  readonly name?: string
}

export interface DeleteSpec {
  readonly using: Expr
  readonly name?: string
}

/**
 * The `FOR ALL` spec used by restrictive policies (ADR-0032). One predicate
 * applies as both `USING` and `WITH CHECK` across every command — the
 * inescapable floor AND'd with every other policy on the table.
 */
export interface AllSpec {
  readonly using: Expr
  readonly check: Expr
  readonly name?: string
}

/**
 * A complete policy: one (model, dbRole) pair with any subset of verbs.
 * Multiple PolicyAsts for the same model are normal — typically one per
 * dbRole, sometimes multiple per role for distinct CRUD subsets.
 *
 * `todos` carries `.todo()` markers added during authoring (typically by the
 * scaffold importer). They emit as SQL comments and the lint extension flags
 * non-empty `todos` arrays as work-in-progress.
 */
export interface PolicyAst {
  readonly model: string
  readonly dbRole: string
  readonly table: string | undefined
  readonly select: SelectSpec | undefined
  readonly insert: InsertSpec | undefined
  readonly update: UpdateSpec | undefined
  readonly delete: DeleteSpec | undefined
  /**
   * The `FOR ALL` spec used by restrictive policies (ADR-0032). Set on a
   * `.restrictivePolicy(role).forAll(...)` or `.isolation(...)` declaration;
   * never set alongside `select`/`insert`/`update`/`delete` (a single
   * `PolicyAst` is either permissive-per-verb OR restrictive-for-all).
   */
  readonly all: AllSpec | undefined
  /**
   * True for restrictive policies (ADR-0032). Emits as `AS RESTRICTIVE`; the
   * predicate is AND'd with every permissive on the same table. Default
   * undefined/false = permissive.
   */
  readonly restrictive?: boolean
  /**
   * Set when this policy was declared via `.isolation(...)` (ADR-0032). Used
   * by the lifecycle to pick the auto-name `<table>_isolation` instead of the
   * generic `<table>_<role>_all` and surfaced to lint as informational. Has no
   * effect on emitted SQL.
   */
  readonly isolation?: boolean
  readonly todos: ReadonlyArray<string>
}

/**
 * Per-column, per-verb privilege grants. Compiles to `GRANT SELECT(col) ON
 * table TO role` / `REVOKE ...` DDL via `@flowchestra/prisma-guarddog-emitter-postgres-
 * column-privileges`. Role-based and **static** — independent of row content.
 *
 * Row-conditional field visibility (`.masks()` / `.projection()`) is a
 * distinct primitive scheduled for Phase 2 (see ADR-0004).
 */
export interface ColumnPrivilegeAst {
  readonly model: string
  readonly table: string | undefined
  readonly columns: Readonly<Record<string, ColumnPrivilegeGrant>>
}

export interface ColumnPrivilegeGrant {
  readonly select: ReadonlyArray<string>
  readonly insert: ReadonlyArray<string>
  readonly update: ReadonlyArray<string>
}

/**
 * Explicit coverage opt-out for a Prisma model. The lint extension treats a
 * Prisma model as covered if it has at least one `PolicyAst`, OR a
 * `NoPolicyAst` with a non-empty reason. Forcing a `reason` makes the
 * decision auditable — a NoPolicy is a real decision, not a forgotten one.
 */
export interface NoPolicyAst {
  readonly model: string
  readonly reason: string
}

/**
 * Polymorphic table — one Prisma model whose rows fan out to multiple
 * physical target models via a discriminator column.
 *
 * Example: a `ScopeTarget` table with `targetType` ∈ {Workspace, Workbench,
 * File} and `targetId` referencing the appropriate target row. The access
 * rules typically differ per target type, so the policy author wants to
 * declare them once per target without manually restating `targetType =
 * 'X'` in every predicate.
 *
 * The emitter walks the target list and produces one Postgres `CREATE
 * POLICY` per (target, verb, dbRole), automatically prepending the
 * discriminator equality to each policy's `USING` / `WITH CHECK`.
 */
export interface PolymorphicAst {
  readonly modelName: string
  readonly table: string | undefined
  readonly discriminator: string
  readonly targets: ReadonlyArray<PolymorphicTargetAst>
}

export interface PolymorphicTargetAst {
  readonly discriminatorValue: string
  readonly targetModelName: string
  readonly policies: ReadonlyArray<PolymorphicTargetPolicyAst>
}

/**
 * Per-(target, dbRole) policy spec. Structurally identical to `PolicyAst`
 * minus `model` and `table` (those live on the enclosing `PolymorphicAst`).
 */
export interface PolymorphicTargetPolicyAst {
  readonly dbRole: string
  readonly select: SelectSpec | undefined
  readonly insert: InsertSpec | undefined
  readonly update: UpdateSpec | undefined
  readonly delete: DeleteSpec | undefined
  readonly todos: ReadonlyArray<string>
}
