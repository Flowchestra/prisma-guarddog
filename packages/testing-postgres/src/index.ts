/**
 * `@prisma-guarddog/testing-postgres` — RLS verification harness.
 *
 * Phase 1 surface (implementation pending):
 *   - `withDbRole(role, fn)` — SET LOCAL ROLE inside a transaction
 *   - `withClaims(claims, fn)` — SET LOCAL request.jwt.claims = '...'
 *   - `assertAllowed(promise)` / `assertDenied(promise)`
 *   - `assertVisibleRows(query, expected)` / `assertHiddenColumns(row, columns)`
 *
 * Real Postgres only. No pg-mem / pglite shims accepted. See ADR-0013.
 */

export {};
