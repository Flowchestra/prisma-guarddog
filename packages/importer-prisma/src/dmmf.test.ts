import { describe, expect, it } from 'vitest'

import { parsePrismaModels } from './dmmf.js'

describe('parsePrismaModels', () => {
  it('extracts model names from a minimal schema.prisma', async () => {
    const datamodel = `
      datasource db {
        provider = "postgresql"
        url      = "postgres://localhost/test"
      }

      generator client {
        provider = "prisma-client-js"
      }

      model Workbench {
        id String @id
      }

      model Workspace {
        id String @id
      }
    `
    const models = await parsePrismaModels(datamodel)
    expect(models.map((m) => m.name).toSorted()).toEqual(['Workbench', 'Workspace'])
  })

  it('captures @@map() overrides as tableName', async () => {
    const datamodel = `
      datasource db {
        provider = "postgresql"
        url      = "postgres://localhost/test"
      }

      generator client {
        provider = "prisma-client-js"
      }

      model User {
        id String @id

        @@map("app_user_account")
      }
    `
    const models = await parsePrismaModels(datamodel)
    expect(models).toHaveLength(1)
    expect(models[0]?.name).toBe('User')
    expect(models[0]?.tableName).toBe('app_user_account')
  })

  it('returns tableName === name when @@map is absent', async () => {
    const datamodel = `
      datasource db {
        provider = "postgresql"
        url      = "postgres://localhost/test"
      }

      generator client {
        provider = "prisma-client-js"
      }

      model Workbench {
        id String @id
      }
    `
    const models = await parsePrismaModels(datamodel)
    expect(models[0]?.tableName).toBe('Workbench')
  })

  it('rejects an empty datamodel before invoking getDMMF', async () => {
    await expect(parsePrismaModels('')).rejects.toThrow(/datamodel must be a non-empty string/)
  })

  it('returns a frozen, immutable result', async () => {
    const datamodel = `
      datasource db {
        provider = "postgresql"
        url      = "postgres://localhost/test"
      }

      generator client {
        provider = "prisma-client-js"
      }

      model X {
        id String @id
      }
    `
    const models = await parsePrismaModels(datamodel)
    expect(Object.isFrozen(models)).toBe(true)
    expect(Object.isFrozen(models[0])).toBe(true)
  })
})
