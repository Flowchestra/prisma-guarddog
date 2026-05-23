/**
 * `@flowchestra/prisma-guarddog-emitter-postgres-column-privileges` — pure AST -> SQL
 * transformer for Postgres column-level GRANT statements.
 *
 * Per ADR-0004, this emitter handles only STATIC role-based column
 * privileges. Row-conditional field masking (`.masks()` / `.projection()`)
 * is Phase 2 and lives in a separate emitter package.
 *
 * No I/O, no DB connection, no filesystem access. Emitted GRANT
 * statements are natively idempotent.
 */

export { emitColumnPrivileges } from './emit.js'
export type { EmitContext } from './emit.js'

export { defaultTableResolver, quoteIdent, resolveTableName } from './identifiers.js'
