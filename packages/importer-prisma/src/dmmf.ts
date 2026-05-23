/**
 * Read the consumer's `schema.prisma` and extract the list of Prisma models
 * via `@prisma/internals.getDMMF()`. The result is the input to the type
 * codegen step (`./codegen.ts`).
 *
 * Two entry points:
 *   - `parsePrismaModels(datamodel)` accepts the raw schema text. Pure
 *     async function (no filesystem) — primary unit-testing target.
 *   - `readPrismaModels(schemaPath)` reads the file then delegates to
 *     `parsePrismaModels`. The CLI / generator-binary call this one.
 */

import { readFile } from 'node:fs/promises'

import { getDMMF } from '@prisma/internals'

export interface PrismaModel {
  /** Prisma model name as declared in `schema.prisma` (e.g. `Workbench`). */
  readonly name: string
  /**
   * Resolved table name. Equal to `name` unless overridden by `@@map`.
   * Drives the table-name resolver in the RLS emitter — see
   * `@flowchestra/prisma-guarddog-emitter-postgres-rls`'s `defaultTableResolver`.
   */
  readonly tableName: string
}

/**
 * Parse a Prisma datamodel string into the model list. Async because
 * `getDMMF` is async (it spawns the Prisma query-engine for validation).
 */
export async function parsePrismaModels(datamodel: string): Promise<readonly PrismaModel[]> {
  if (datamodel.length === 0) {
    throw new Error('[prisma-guarddog/importer-prisma] parsePrismaModels: datamodel must be a non-empty string.')
  }
  const dmmf = await getDMMF({ datamodel })
  return Object.freeze(
    dmmf.datamodel.models.map((m) =>
      Object.freeze({
        name: m.name,
        // `dbName` is the Prisma DMMF field that captures @@map() overrides.
        // Null when no @@map is set — fall back to the model name verbatim.
        tableName: m.dbName ?? m.name,
      })
    )
  )
}

/**
 * Read a `schema.prisma` from disk and return the parsed model list.
 */
export async function readPrismaModels(schemaPath: string): Promise<readonly PrismaModel[]> {
  let datamodel: string
  try {
    datamodel = await readFile(schemaPath, 'utf8')
  } catch (err) {
    throw new Error(
      `[prisma-guarddog/importer-prisma] readPrismaModels: failed to read ${schemaPath}: ${(err as Error).message}`,
      { cause: err }
    )
  }
  return parsePrismaModels(datamodel)
}
