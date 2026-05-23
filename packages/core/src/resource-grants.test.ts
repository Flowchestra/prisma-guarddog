import { describe, expect, it } from 'vitest'

import { defineResourceGrants, type ResourceGrantsDefinition } from './resource-grants.js'

describe('defineResourceGrants', () => {
  it('captures the action vocabulary and freezes the definition', () => {
    const rg = defineResourceGrants({
      actions: ['read', 'write', 'edit', 'delete'] as const,
    })
    expect(rg.actions).toEqual(['read', 'write', 'edit', 'delete'])
    expect(rg.source).toBe('claims')
    expect(rg.claimPath).toBe('grants')
    expect(Object.isFrozen(rg)).toBe(true)
    expect(Object.isFrozen(rg.actions)).toBe(true)
  })

  it('defaults source to "claims"', () => {
    const rg = defineResourceGrants({ actions: ['read'] as const })
    expect(rg.source).toBe('claims')
  })

  it('defaults claimPath to "grants"', () => {
    const rg = defineResourceGrants({ actions: ['read'] as const })
    expect(rg.claimPath).toBe('grants')
  })

  it('honors a custom claimPath', () => {
    const rg = defineResourceGrants({
      claimPath: 'permissions',
      actions: ['read'] as const,
    })
    expect(rg.claimPath).toBe('permissions')
  })

  it('infers a literal-union TActions from the input array (const-typed)', () => {
    const rg = defineResourceGrants({ actions: ['a', 'b', 'c'] as const })
    // Type-level assertion via assignment compatibility:
    const _check: ResourceGrantsDefinition<'a' | 'b' | 'c'> = rg
    void _check
    expect(rg.actions).toEqual(['a', 'b', 'c'])
  })

  it('rejects an empty actions array', () => {
    expect(() => defineResourceGrants({ actions: [] })).toThrow(/actions must be a non-empty array/)
  })

  it('rejects empty action names', () => {
    expect(() => defineResourceGrants({ actions: ['read', ''] })).toThrow(/action names must be non-empty strings/)
  })

  it('rejects duplicate actions', () => {
    expect(() => defineResourceGrants({ actions: ['read', 'write', 'read'] })).toThrow(/duplicate action "read"/)
  })

  it('rejects an empty claimPath', () => {
    expect(() => defineResourceGrants({ claimPath: '', actions: ['read'] })).toThrow(
      /claimPath must be a non-empty string/
    )
  })
})
