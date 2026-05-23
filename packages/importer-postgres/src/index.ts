/**
 * `@prisma-guarddog/importer-postgres` — pg_policies + column-privileges importer.
 *
 * Phase 1 surface (implementation pending):
 *   - Reads `pg_policies` and `information_schema.column_privileges` via a
 *     consumer-provided pg client
 *   - Emits TS scaffolds: existing policies become `rawSql()` + `.todo()`
 *   - Tables with no detected policies become `noPolicy({ reason: '...' })`
 *
 * Scaffold-only — SQL is evidence, not gospel. The importer NEVER attempts to
 * reverse-engineer business intent into typed predicates. See ADR-0012.
 */

export {};
