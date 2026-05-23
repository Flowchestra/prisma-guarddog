/**
 * `@prisma-guarddog/importer-prisma` — Prisma DMMF importer.
 *
 * Phase 1 surface (implementation pending):
 *   - Reads Prisma's DMMF via `@prisma/internals`
 *   - Cross-references against guarddog policies registry
 *   - Emits `noPolicy()` stubs for any Prisma model not covered
 *   - Provides model-coverage data to the lint extension
 *
 * Scaffold-only — never reverse-engineers business intent. See ADR-0012.
 */

export {};
