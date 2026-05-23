/**
 * Load and materialize the user's schema file.
 *
 * The user's `prisma/guarddog.ts` is a TypeScript file that
 * `export default`s a `SchemaDefinition` built by `defineSchema(...)`. We
 * load it at runtime via `jiti` (handles TS without a build step) and pass
 * the default export through `materializeSchema` to produce a populated
 * `Guarddog`.
 *
 * Validation is factored into `validateSchemaModule` as a pure function so
 * the failure modes can be unit-tested without exercising jiti. `loadSchema`
 * wraps validation with the file-read + jiti.import sequence.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Guarddog, materializeSchema, type ClaimsShape, type SchemaDefinition } from '@flowchestra/prisma-guarddog-core'
import { createJiti } from 'jiti'

export class SchemaLoadError extends Error {
  readonly schemaPath: string
  override readonly cause: unknown
  constructor(message: string, schemaPath: string, cause?: unknown) {
    super(message)
    this.name = 'SchemaLoadError'
    this.schemaPath = schemaPath
    this.cause = cause
  }
}

export interface LoadedSchema {
  readonly schemaPath: string
  readonly schema: SchemaDefinition
  readonly guard: Guarddog
}

/**
 * Validate that an imported module exports a `SchemaDefinition` and unwrap
 * it from its default-export envelope. Pure function — no I/O, no jiti.
 *
 * Accepts either `{ default: SchemaDefinition }` (the canonical
 * ESM-default-export form) or a bare `SchemaDefinition` (for codebases that
 * use `export = ` CommonJS interop). Throws `SchemaLoadError` with a clear
 * pointer when the shape doesn't match.
 */
export function validateSchemaModule(mod: unknown, schemaPath: string): SchemaDefinition {
  if (typeof mod !== 'object' || mod === null) {
    throw new SchemaLoadError(
      `[prisma-guarddog] schema file ${schemaPath} did not export a SchemaDefinition value.\n` +
        '  Make sure the file `export default`s a value built via `defineSchema({...})`.',
      schemaPath
    )
  }
  const maybeWrapped = mod as { default?: unknown }
  const candidate = 'default' in maybeWrapped && maybeWrapped.default !== undefined ? maybeWrapped.default : mod
  if (typeof candidate !== 'object' || candidate === null) {
    throw new SchemaLoadError(
      `[prisma-guarddog] schema file ${schemaPath} default export is not a SchemaDefinition.\n` +
        '  Build the schema via `defineSchema({...})` from `prisma-guarddog`.',
      schemaPath
    )
  }
  if (typeof (candidate as SchemaDefinition).policies !== 'function') {
    throw new SchemaLoadError(
      `[prisma-guarddog] schema file ${schemaPath} default export is missing a \`policies(guard)\` callback.\n` +
        '  Build the schema via `defineSchema({...})` from `prisma-guarddog`.',
      schemaPath
    )
  }
  return candidate as SchemaDefinition
}

/**
 * Materialize an already-validated schema into a `Guarddog`. Separated so
 * tests can exercise the materialization error path without going through
 * jiti. Generic over the same generics as `materializeSchema` so narrow
 * schema types from `defineSchema` flow through without losing inference.
 */
export function materializeLoadedSchema<
  TClaimsShape extends ClaimsShape,
  TDbRoles extends string,
  TAppRoles extends string,
  TResources extends string,
  TActions extends string,
>(schema: SchemaDefinition<TClaimsShape, TDbRoles, TAppRoles, TResources, TActions>, schemaPath: string): LoadedSchema {
  let guard: Guarddog<TClaimsShape, TDbRoles, TAppRoles, TResources, TActions>
  try {
    guard = materializeSchema(schema)
  } catch (err) {
    throw new SchemaLoadError(
      `[prisma-guarddog] failed to materialize schema ${schemaPath}: ${(err as Error).message}`,
      schemaPath,
      err
    )
  }
  return Object.freeze({
    schemaPath,
    schema: schema as unknown as SchemaDefinition,
    guard: guard as unknown as Guarddog,
  })
}

/**
 * End-to-end load: file exists -> jiti import -> validate -> materialize.
 * Throws `SchemaLoadError` with a clear diagnostic on any step's failure.
 */
export async function loadSchema(schemaPath: string): Promise<LoadedSchema> {
  if (!existsSync(schemaPath)) {
    throw new SchemaLoadError(
      `[prisma-guarddog] schema file not found at ${schemaPath}.\n` +
        '  Create one at prisma/guarddog.ts (sibling to your Prisma schema),\n' +
        '  or point at a different location via guarddog.config.ts.',
      schemaPath
    )
  }

  const jiti = createJiti(fileURLToPath(import.meta.url))

  let mod: unknown
  try {
    mod = await jiti.import(schemaPath)
  } catch (err) {
    throw new SchemaLoadError(
      `[prisma-guarddog] failed to load schema file ${schemaPath}: ${(err as Error).message}`,
      schemaPath,
      err
    )
  }

  const schema = validateSchemaModule(mod, schemaPath)
  return materializeLoadedSchema(schema, schemaPath)
}
