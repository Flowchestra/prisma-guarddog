/**
 * `@prisma-guarddog/importer-prisma` — Prisma DMMF importer.
 *
 * Two responsibilities:
 *   1. Read the consumer's `schema.prisma` and extract the list of models
 *      (with `@@map`-resolved table names). See `./dmmf.ts`.
 *   2. Generate the DMMF-bridged TypeScript types that consumers import
 *      into their guarddog schema file so model-name references autocomplete
 *      against the current Prisma schema. See `./codegen.ts`.
 *
 * The CLI invokes these on `prisma-guarddog generate`. A future Prisma
 * generator binary (task 7) wires the same logic into the
 * `generator guarddog { provider = "prisma-guarddog" }` block, so
 * `prisma generate` triggers it natively.
 *
 * Scaffold-mode policy import (the larger ADR-0012 work — generating
 * `rawSql()` / `.todo()` stubs from existing `pg_policies`) lives
 * alongside this module in a future commit.
 */

export { parsePrismaModels, readPrismaModels } from './dmmf.js'
export type { PrismaModel } from './dmmf.js'

export { generateModelTypes, writeModelTypes } from './codegen.js'
export type { CodegenOptions } from './codegen.js'
