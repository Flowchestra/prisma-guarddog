/**
 * `@prisma-guarddog/emitter-postgres-column-privileges` — column GRANT/REVOKE emitter.
 *
 * Phase 1 surface (implementation pending):
 *   - Static role-based column privileges only (NOT row-conditional masking)
 *   - GRANT SELECT(col) / UPDATE(col) / INSERT(col) ON table TO role
 *   - REVOKE counterparts (natively idempotent)
 *
 * Row-conditional field masking (`.masks()` / `.projection()`) is Phase 2 and
 * belongs in a separate emitter. See ADR-0004.
 */

export {};
