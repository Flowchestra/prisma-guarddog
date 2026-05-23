/**
 * `@prisma-guarddog/emitter-postgres-rls` — pure AST -> SQL transformer.
 *
 * Public API:
 *   - `emitPolicy(policy, ctx)`           PolicyAst       -> readonly string[]
 *   - `emitPolymorphic(poly, ctx)`        PolymorphicAst  -> readonly string[]
 *   - `emitRoles(dbRoles)`                DbRolesDef      -> readonly string[]
 *   - `compileExpr(expr, exprCtx)`        Expr            -> string (SQL fragment)
 *
 * No I/O, no DB connection, no filesystem access. Emitted DDL is idempotent
 * per ADR-0008 — every CREATE POLICY is preceded by DROP POLICY IF EXISTS,
 * ENABLE/FORCE RLS are natively idempotent, and CREATE ROLE / GRANT
 * membership statements are wrapped in DO blocks that check pg_roles /
 * pg_auth_members first. Consumers should still orchestrate per-table dedup
 * of the ENABLE/FORCE prelude when bundling multiple policies (that's the
 * `.emit()` lifecycle in core, landing later).
 */

export { compileExpr, defaultCompileHasRole, defaultCompileIsOwner } from './compile-expr.js'
export type { ExprCompileCtx, HasRoleCompiler, IsOwnerCompiler } from './compile-expr.js'

export { emitPolicy, emitPolymorphic } from './emit.js'
export type { EmitContext } from './emit.js'

export { emitRoles } from './emit-roles.js'

export { defaultTableResolver, formatLiteral, policyName, quoteIdent, quoteString } from './identifiers.js'
