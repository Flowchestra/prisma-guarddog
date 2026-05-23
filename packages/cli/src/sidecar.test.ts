import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Op } from '@flowchestra/prisma-guarddog-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { formatSidecar, readAllSidecarOps, replayMigrationsDir, SIDECAR_FILENAME, SIDECAR_VERSION } from './sidecar.js'

const enableRls = (table: string): Op => ({ kind: 'enable-rls', table })

describe('sidecar', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'guarddog-sidecar-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns empty state for a missing migrations dir', async () => {
    const state = await replayMigrationsDir(join(dir, 'does-not-exist'))
    expect(state.rlsEnabled.size).toBe(0)
  })

  it('returns empty state when no folders contain a sidecar', async () => {
    await mkdir(join(dir, '20260101_prisma_only'), { recursive: true })
    await writeFile(join(dir, '20260101_prisma_only', 'migration.sql'), 'SELECT 1;\n', 'utf8')
    const state = await replayMigrationsDir(dir)
    expect(state.rlsEnabled.size).toBe(0)
  })

  it('replays sidecars in lexicographic folder order', async () => {
    const first = join(dir, '20260101_one')
    const second = join(dir, '20260102_two')
    await mkdir(first, { recursive: true })
    await mkdir(second, { recursive: true })
    await writeFile(join(first, SIDECAR_FILENAME), formatSidecar([enableRls('workspace')]), 'utf8')
    await writeFile(
      join(second, SIDECAR_FILENAME),
      formatSidecar([{ kind: 'disable-rls', table: 'workspace' }]),
      'utf8'
    )

    const ops = await readAllSidecarOps(dir)
    expect(ops.map((o) => o.kind)).toEqual(['enable-rls', 'disable-rls'])
    const state = await replayMigrationsDir(dir)
    expect(state.rlsEnabled.has('workspace')).toBe(false)
  })

  it('rejects sidecars with an unsupported version', async () => {
    const folder = join(dir, '20260101_bad')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, SIDECAR_FILENAME), JSON.stringify({ version: 999, ops: [] }), 'utf8')
    await expect(replayMigrationsDir(dir)).rejects.toThrow(/unsupported sidecar version/)
  })

  it('formatSidecar() round-trips through JSON.parse', () => {
    const ops: Op[] = [enableRls('a'), enableRls('b')]
    const text = formatSidecar(ops)
    const parsed = JSON.parse(text) as { version: number; ops: Op[] }
    expect(parsed.version).toBe(SIDECAR_VERSION)
    expect(parsed.ops).toHaveLength(2)
  })
})
