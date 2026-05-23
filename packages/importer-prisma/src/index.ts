/**
 * `@prisma-guarddog/importer-prisma` — Prisma DMMF importer + generator
 * handler.
 *
 * Three responsibilities:
 *   1. Read the consumer's `schema.prisma` and extract the list of models
 *      (with `@@map`-resolved table names). See `./dmmf.ts`.
 *   2. Generate the DMMF-bridged TypeScript types that consumers import
 *      into their guarddog schema file so model-name references autocomplete
 *      against the current Prisma schema. See `./codegen.ts`.
 *   3. Provide the library-side handler that the Prisma generator binary
 *      (`packages/cli/src/generator-bin.ts`) invokes when `prisma generate`
 *      runs against a `generator guarddog { ... }` block. See `./generator.ts`.
 *
 * Scaffold-mode policy import (the larger ADR-0012 work — generating
 * `rawSql()` / `.todo()` stubs from existing `pg_policies`) lives alongside
 * this module in a future commit.
 */

export { parsePrismaModels, readPrismaModels } from './dmmf.js'
export type { PrismaModel } from './dmmf.js'

export { generateModelTypes, writeModelTypes } from './codegen.js'
export type { CodegenOptions } from './codegen.js'

export { resolveGeneratorOutputPath, runGuarddogGenerator } from './generator.js'
export type { RunGuarddogGeneratorResult } from './generator.js'
