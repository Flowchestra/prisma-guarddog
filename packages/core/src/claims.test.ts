import { describe, expect, expectTypeOf, it } from 'vitest'

import { defineClaims, type ClaimField, type InferClaims } from './claims.js'

describe('defineClaims', () => {
  it('captures the accessor verbatim', () => {
    const claims = defineClaims({
      accessor: 'request.jwt.claims',
      shape: (c) => ({ sub: c.uuid() }),
    })
    expect(claims.accessor).toBe('request.jwt.claims')
  })

  it('rejects an empty accessor', () => {
    expect(() =>
      defineClaims({
        accessor: '',
        shape: (c) => ({ sub: c.uuid() }),
      })
    ).toThrow(/accessor must be a non-empty string/)
  })

  it('records primitive field kinds', () => {
    const claims = defineClaims({
      accessor: 'x',
      shape: (c) => ({
        s: c.string(),
        u: c.uuid(),
        i: c.integer(),
        b: c.boolean(),
      }),
    })
    expect(claims.shape.s).toMatchObject({ kind: 'string', isArray: false, isNullable: false })
    expect(claims.shape.u).toMatchObject({ kind: 'uuid', isArray: false, isNullable: false })
    expect(claims.shape.i).toMatchObject({ kind: 'integer', isArray: false, isNullable: false })
    expect(claims.shape.b).toMatchObject({ kind: 'boolean', isArray: false, isNullable: false })
  })

  it('marks arrays with isArray=true while preserving inner kind', () => {
    const claims = defineClaims({
      accessor: 'x',
      shape: (c) => ({ roles: c.array(c.string()), ids: c.array(c.uuid()) }),
    })
    expect(claims.shape.roles).toMatchObject({ kind: 'string', isArray: true, isNullable: false })
    expect(claims.shape.ids).toMatchObject({ kind: 'uuid', isArray: true, isNullable: false })
  })

  it('marks optional fields with isNullable=true', () => {
    const claims = defineClaims({
      accessor: 'x',
      shape: (c) => ({ workbenchId: c.optional(c.uuid()) }),
    })
    expect(claims.shape.workbenchId).toMatchObject({
      kind: 'uuid',
      isArray: false,
      isNullable: true,
    })
  })

  it('supports optional arrays (carries both flags)', () => {
    const claims = defineClaims({
      accessor: 'x',
      shape: (c) => ({ maybeRoles: c.optional(c.array(c.string())) }),
    })
    expect(claims.shape.maybeRoles).toMatchObject({
      kind: 'string',
      isArray: true,
      isNullable: true,
    })
  })

  it('produces frozen shape and definition', () => {
    const claims = defineClaims({
      accessor: 'x',
      shape: (c) => ({ sub: c.uuid() }),
    })
    expect(Object.isFrozen(claims)).toBe(true)
    expect(Object.isFrozen(claims.shape)).toBe(true)
    expect(Object.isFrozen(claims.shape.sub)).toBe(true)
  })

  it('infers the JS-level claim shape via InferClaims', () => {
    const claims = defineClaims({
      accessor: 'x',
      shape: (c) => ({
        sub: c.uuid(),
        tenantId: c.uuid(),
        roles: c.array(c.string()),
        workbenchId: c.optional(c.uuid()),
        count: c.integer(),
        active: c.boolean(),
      }),
    })

    type Inferred = InferClaims<typeof claims>
    expectTypeOf<Inferred>().toEqualTypeOf<{
      sub: string
      tenantId: string
      roles: string[]
      workbenchId: string | null
      count: number
      active: boolean
    }>()
  })

  it('treats each field as a typed ClaimField', () => {
    const claims = defineClaims({
      accessor: 'x',
      shape: (c) => ({ sub: c.uuid(), n: c.integer() }),
    })
    expectTypeOf(claims.shape.sub).toEqualTypeOf<ClaimField<string>>()
    expectTypeOf(claims.shape.n).toEqualTypeOf<ClaimField<number>>()
  })
})
