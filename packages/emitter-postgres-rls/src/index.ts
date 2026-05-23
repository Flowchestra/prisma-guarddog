/**
 * `@prisma-guarddog/emitter-postgres-rls` — Postgres RLS DDL emitter.
 *
 * Phase 1 surface (implementation pending):
 *   - Pure AST -> string[] transformation
 *   - CREATE POLICY (via DROP IF EXISTS + CREATE; see ADR-0008)
 *   - ALTER TABLE ENABLE/FORCE ROW LEVEL SECURITY
 *   - Table-level REVOKE
 *
 * No I/O. No DB connection. No filesystem access.
 * See ../../../docs/adr/0008-idempotent-ddl-emission.md.
 */

export {};
