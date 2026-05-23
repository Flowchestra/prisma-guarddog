import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { GeneratorOptions } from '@prisma/generator-helper'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resolveGeneratorOutputPath, runGuarddogGenerator } from './generator.js'

let workDir: string
beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'guarddog-gen-'))
})
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

/**
 * Build a minimal GeneratorOptions fixture. Only the fields runGuarddogGenerator
 * actually reads are populated; the rest of the GeneratorOptions surface is
 * cast through `unknown` because we don't exercise it.
 */
function makeOptions(opts: {
  models: ReadonlyArray<{ name: string; dbName?: string | null }>
  outputValue?: string | undefined
  schemaPath?: string
}): GeneratorOptions {
  const schemaPath = opts.schemaPath ?? join(workDir, 'schema.prisma')
  return {
    dmmf: {
      datamodel: {
        models: opts.models.map((m) => ({
          name: m.name,
          dbName: m.dbName ?? null,
          fields: [],
          uniqueFields: [],
          uniqueIndexes: [],
          primaryKey: null,
          schema: null,
        })),
        enums: [],
        types: [],
        indexes: [],
      },
      // The rest of the DMMF (schema, mappings) isn't touched by our codegen.
      schema: { inputObjectTypes: {}, outputObjectTypes: { model: [], prisma: [] }, enumTypes: { prisma: [] } },
      mappings: { modelOperations: [], otherOperations: { read: [], write: [] } },
    },
    schemaPath,
    generator: {
      name: 'guarddog',
      provider: { value: 'prisma-guarddog-generator', fromEnvVar: null },
      output: opts.outputValue === undefined ? null : { value: opts.outputValue, fromEnvVar: null },
      config: {},
      binaryTargets: [],
      previewFeatures: [],
      sourceFilePath: schemaPath,
    },
    otherGenerators: [],
    schemaPath_: schemaPath,
    version: 'test',
    datamodel: '',
    datasources: [],
  } as unknown as GeneratorOptions
}

describe('resolveGeneratorOutputPath', () => {
  it('uses defaultRelative when the generator block omits `output`', () => {
    const opts = makeOptions({ models: [], outputValue: undefined })
    expect(resolveGeneratorOutputPath(opts, 'gen/x.ts')).toBe(resolve(workDir, 'gen/x.ts'))
  })

  it('resolves a relative `output` against schemaPath dir', () => {
    const opts = makeOptions({ models: [], outputValue: '../shared/x.ts' })
    expect(resolveGeneratorOutputPath(opts, 'unused')).toBe(resolve(workDir, '../shared/x.ts'))
  })

  it('honors an absolute `output` verbatim', () => {
    const opts = makeOptions({ models: [], outputValue: '/abs/path.ts' })
    expect(resolveGeneratorOutputPath(opts, 'unused')).toBe('/abs/path.ts')
  })
})

describe('runGuarddogGenerator', () => {
  it('writes the generated source to the resolved output path', async () => {
    const opts = makeOptions({
      models: [{ name: 'Workbench' }, { name: 'Workspace' }],
      outputValue: 'gen/guarddog-models.ts',
    })
    const result = await runGuarddogGenerator(opts)

    expect(result.modelCount).toBe(2)
    expect(result.outputPath).toBe(resolve(workDir, 'gen/guarddog-models.ts'))

    const written = readFileSync(result.outputPath, 'utf8')
    expect(written).toContain("Workbench: 'Workbench'")
    expect(written).toContain("Workspace: 'Workspace'")
    expect(written).toContain('export type ModelName = (typeof Models)[keyof typeof Models]')
  })

  it('propagates @@map() table-name overrides into ModelTables', async () => {
    const opts = makeOptions({
      models: [{ name: 'User', dbName: 'app_user_account' }],
      outputValue: 'gen/m.ts',
    })
    const result = await runGuarddogGenerator(opts)
    const written = readFileSync(result.outputPath, 'utf8')
    expect(written).toContain("User: 'app_user_account'")
  })

  it('creates parent directories on first run', async () => {
    const opts = makeOptions({
      models: [{ name: 'X' }],
      outputValue: 'deep/nested/dir/m.ts',
    })
    const result = await runGuarddogGenerator(opts)
    expect(result.outputPath).toBe(resolve(workDir, 'deep/nested/dir/m.ts'))
    expect(readFileSync(result.outputPath, 'utf8').length).toBeGreaterThan(0)
  })

  it('handles an empty model list (no Prisma models declared)', async () => {
    const opts = makeOptions({
      models: [],
      outputValue: 'gen/empty.ts',
    })
    const result = await runGuarddogGenerator(opts)
    expect(result.modelCount).toBe(0)
    const written = readFileSync(result.outputPath, 'utf8')
    expect(written).toContain('export const Models = {} as const')
    expect(written).toContain('export type ModelName = never')
  })

  it('returned result is frozen', async () => {
    const opts = makeOptions({ models: [{ name: 'X' }], outputValue: 'gen/frozen.ts' })
    const result = await runGuarddogGenerator(opts)
    expect(Object.isFrozen(result)).toBe(true)
  })
})
