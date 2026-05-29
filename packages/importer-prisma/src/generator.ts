/**
 * Prisma generator integration. The actual binary entry point (which speaks
 * the Prisma generator JSON-RPC protocol via `@prisma/generator-helper`)
 * lives in `packages/cli/src/generator-bin.ts`. This file is the
 * library-side handler: a pure(-ish) async function that takes a Prisma
 * `GeneratorOptions` value and writes the codegen output.
 *
 * Factored this way so:
 *   - the binary file stays tiny (just `generatorHandler({ onGenerate:
 *     runGuarddogGenerator, onManifest })`),
 *   - the handler can be unit-tested by passing synthetic options +
 *     inspecting the written file,
 *   - other entry points (a CLI `generate` subcommand, in-process testing)
 *     can reuse the exact same logic without re-implementing the
 *     DMMF -> codegen plumbing.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

import type { GeneratorOptions } from '@prisma/generator-helper'

import { generateModelTypes } from './codegen.js'
import type { PrismaModel } from './dmmf.js'

/**
 * Resolve the output path the user specified in their generator block. The
 * Prisma generator protocol gives us `options.generator.output` as either
 * `null` (use defaultOutput) or `{ value: '<path>', fromEnvVar: ... }`.
 * We resolve relative paths against `options.schemaPath`'s directory, mirroring
 * how `prisma-client-js` handles output paths.
 */
export function resolveGeneratorOutputPath(options: GeneratorOptions, defaultRelative: string): string {
  const rawValue = options.generator.output?.value
  const base = dirname(options.schemaPath)
  if (rawValue === undefined || rawValue === null || rawValue.length === 0) {
    return resolve(base, defaultRelative)
  }
  return isAbsolute(rawValue) ? rawValue : resolve(base, rawValue)
}

export interface RunGuarddogGeneratorResult {
  readonly outputPath: string
  readonly modelCount: number
}

/**
 * Drive the codegen step: pull the model list out of the DMMF, render the
 * TypeScript source via `generateModelTypes`, write to the resolved
 * output path. Returns where it wrote and how many models were emitted —
 * useful for the binary's stdout summary and for tests.
 */
export async function runGuarddogGenerator(options: GeneratorOptions): Promise<RunGuarddogGeneratorResult> {
  const models: PrismaModel[] = options.dmmf.datamodel.models.map((m) => ({
    name: m.name,
    tableName: m.dbName ?? m.name,
    columns: m.fields
      .filter((f) => f.kind !== 'object')
      .map((f) => f.dbName ?? f.name)
      .toSorted(),
  }))

  const outputPath = resolveGeneratorOutputPath(options, 'generated/guarddog-models.ts')
  const source = generateModelTypes(models)

  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, source, 'utf8')

  return Object.freeze({ outputPath, modelCount: models.length })
}
