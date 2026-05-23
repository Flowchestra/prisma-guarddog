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

export type Verb = 'select' | 'insert' | 'update' | 'delete'

/**
 * Expression AST. Predicates inside USING and WITH CHECK clauses produce
 * an `Expr` tree. The emitter walks the tree and renders SQL.
 *
 * `hasRole` is a high-level helper that the emitter expands into the
 * appropriate JOIN-against-claim or `current_setting()->>'roles' @> ARRAY[...]`
 * pattern depending on dialect.
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
  | { readonly kind: 'hasRole'; readonly role: string; readonly scopeColumn: string | undefined }
  | { readonly kind: 'isOwner'; readonly ownerColumn: string }
  | { readonly kind: 'inArray'; readonly needle: Expr; readonly haystack: Expr }
  | { readonly kind: 'raw'; readonly sql: string }

/**
 * Per-verb policy specification. `USING` and `WITH CHECK` are explicit and
 * never inferred from one another (ADR-0005).
 */
export interface SelectSpec {
  readonly using: Expr
}

export interface InsertSpec {
  readonly check: Expr
}

export interface UpdateSpec {
  readonly using: Expr
  readonly check: Expr
}

export interface DeleteSpec {
  readonly using: Expr
}

/**
 * A complete policy: one (model, dbRole) pair with any subset of verbs.
 * Multiple PolicyAsts for the same model are normal — typically one per
 * dbRole, sometimes multiple per role for distinct CRUD subsets.
 */
export interface PolicyAst {
  readonly model: string
  readonly dbRole: string
  readonly table: string | undefined
  readonly select: SelectSpec | undefined
  readonly insert: InsertSpec | undefined
  readonly update: UpdateSpec | undefined
  readonly delete: DeleteSpec | undefined
}
