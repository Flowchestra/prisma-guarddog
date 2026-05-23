import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { discoverConfig, findConfigFile, loadConfigFile, resolveConfig } from './config.js'

describe('resolveConfig (pure)', () => {
  it('returns conventional defaults when no overrides are provided', () => {
    const cfg = resolveConfig({ cwd: '/tmp/proj' })
    expect(cfg.cwd).toBe('/tmp/proj')
    expect(cfg.schemaPath).toBe('/tmp/proj/prisma/guarddog.ts')
    expect(cfg.prismaSchemaPath).toBe('/tmp/proj/prisma/schema.prisma')
    expect(cfg.migrationsDir).toBe('/tmp/proj/prisma/migrations')
    expect(cfg.metadataExt).toBe('.guarddog.json')
  })

  it('resolves relative-path overrides against the supplied overridesBase', () => {
    const cfg = resolveConfig({
      cwd: '/tmp/proj',
      overridesBase: '/tmp/proj/db',
      overrides: { schemaPath: './guarddog.ts', migrationsDir: '../migrations' },
    })
    expect(cfg.schemaPath).toBe('/tmp/proj/db/guarddog.ts')
    expect(cfg.migrationsDir).toBe('/tmp/proj/migrations')
  })

  it('honors absolute-path overrides verbatim', () => {
    const cfg = resolveConfig({
      cwd: '/tmp/proj',
      overrides: { schemaPath: '/abs/schema.ts' },
    })
    expect(cfg.schemaPath).toBe('/abs/schema.ts')
  })

  it('honors a custom metadataExt', () => {
    const cfg = resolveConfig({ cwd: '/tmp/proj', overrides: { metadataExt: '.guard.json' } })
    expect(cfg.metadataExt).toBe('.guard.json')
  })

  it('returns a frozen value', () => {
    const cfg = resolveConfig({ cwd: '/tmp/proj' })
    expect(Object.isFrozen(cfg)).toBe(true)
  })
})

describe('findConfigFile', () => {
  let workDir: string
  function setup() {
    workDir = mkdtempSync(join(tmpdir(), 'guarddog-cfg-'))
    return () => rmSync(workDir, { recursive: true, force: true })
  }

  it('returns undefined when no config file exists', () => {
    const teardown = setup()
    try {
      expect(findConfigFile(workDir)).toBeUndefined()
    } finally {
      teardown()
    }
  })

  it('finds guarddog.config.ts', () => {
    const teardown = setup()
    try {
      const p = join(workDir, 'guarddog.config.ts')
      writeFileSync(p, 'export default {}')
      expect(findConfigFile(workDir)).toBe(p)
    } finally {
      teardown()
    }
  })

  it('finds guarddog.config.js / .mjs in that priority order', () => {
    const teardown = setup()
    try {
      const jsPath = join(workDir, 'guarddog.config.js')
      writeFileSync(jsPath, 'module.exports = {}')
      expect(findConfigFile(workDir)).toBe(jsPath)
    } finally {
      teardown()
    }
  })
})

describe('loadConfigFile + discoverConfig (I/O)', () => {
  it('reads overrides from guarddog.config.ts and folds them into resolveConfig', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'guarddog-cfg-'))
    try {
      writeFileSync(
        join(workDir, 'guarddog.config.ts'),
        `export default { schemaPath: './custom/schema.ts', metadataExt: '.foo.json' }`
      )
      const cfg = await discoverConfig(workDir)
      expect(cfg.schemaPath).toBe(resolve(workDir, 'custom/schema.ts'))
      expect(cfg.metadataExt).toBe('.foo.json')
      // Defaults still apply for unspecified fields:
      expect(cfg.prismaSchemaPath).toBe(resolve(workDir, 'prisma/schema.prisma'))
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  it('returns conventional defaults when no config file is present', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'guarddog-cfg-'))
    try {
      const cfg = await discoverConfig(workDir)
      expect(cfg.schemaPath).toBe(resolve(workDir, 'prisma/guarddog.ts'))
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  it('exposes the raw overrides + base via loadConfigFile', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'guarddog-cfg-'))
    try {
      const configPath = join(workDir, 'guarddog.config.ts')
      writeFileSync(configPath, `export default { metadataExt: '.X' }`)
      const result = await loadConfigFile(configPath)
      expect(result.overrides.metadataExt).toBe('.X')
      expect(result.base).toBe(workDir)
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })
})
