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
  readonly todos: ReadonlyArray<string>
}

/**
 * Per-column, per-verb privilege grants. Compiles to `GRANT SELECT(col) ON
 * table TO role` / `REVOKE ...` DDL via `@prisma-guarddog/emitter-postgres-
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
