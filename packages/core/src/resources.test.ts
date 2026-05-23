import { describe, expect, it } from 'vitest'

import { defineResources } from './resources.js'

const tree = () =>
  defineResources({
    Tenant: { model: 'Tenant', id: 'id', children: ['Org'] },
    Org: {
      model: 'Org',
      id: 'id',
      parent: { resource: 'Tenant', column: 'tenantId' },
      children: ['Workspace'],
    },
    Workspace: {
      model: 'Workspace',
      id: 'id',
      parent: { resource: 'Org', column: 'orgId' },
      children: ['Workbench'],
    },
    Workbench: {
      model: 'Workbench',
      id: 'id',
      parent: { resource: 'Workspace', column: 'workspaceId' },
    },
  })

describe('defineResources', () => {
  it('captures the resource graph and infers roots', () => {
    const t = tree()
    expect(t.roots).toEqual(['Tenant'])
    expect(t.resources.Org.parent).toEqual({ resource: 'Tenant', column: 'tenantId' })
    expect(t.resources.Workspace.children).toEqual(['Workbench'])
    expect(t.resources.Workbench.children).toEqual([])
  })

  it('freezes the result deeply', () => {
    const t = tree()
    expect(Object.isFrozen(t)).toBe(true)
    expect(Object.isFrozen(t.resources)).toBe(true)
    expect(Object.isFrozen(t.resources.Tenant)).toBe(true)
    expect(Object.isFrozen(t.resources.Org.parent)).toBe(true)
  })

  it('rejects a parent reference to an unknown resource', () => {
    expect(() =>
      defineResources({
        // @ts-expect-error — 'Ghost' is not a key of the same call
        Org: { model: 'Org', id: 'id', parent: { resource: 'Ghost', column: 'ghostId' } },
      })
    ).toThrow(/references unknown parent resource "Ghost"/)
  })

  it('rejects a child reference to an unknown resource', () => {
    expect(() =>
      defineResources({
        // @ts-expect-error — 'Ghost' is not a key of the same call
        Tenant: { model: 'Tenant', id: 'id', children: ['Ghost'] },
      })
    ).toThrow(/references unknown child resource "Ghost"/)
  })

  it('rejects parent/child inconsistency', () => {
    expect(() =>
      defineResources({
        Tenant: { model: 'Tenant', id: 'id', children: ['Org'] },
        Org: { model: 'Org', id: 'id' }, // missing parent: { resource: 'Tenant', ... }
      })
    ).toThrow(/"Org"\.parent does not point back to "Tenant"/)
  })

  it('rejects self-parent', () => {
    expect(() =>
      defineResources({
        Org: { model: 'Org', id: 'id', parent: { resource: 'Org', column: 'orgId' } },
      })
    ).toThrow(/cannot be its own parent/)
  })

  it('rejects empty model or id', () => {
    expect(() =>
      defineResources({
        Org: { model: '', id: 'id' },
      })
    ).toThrow(/empty model/)
    expect(() =>
      defineResources({
        Org: { model: 'Org', id: '' },
      })
    ).toThrow(/empty id column/)
  })

  it('rejects empty parent.column', () => {
    expect(() =>
      defineResources({
        Tenant: { model: 'Tenant', id: 'id', children: ['Org'] },
        Org: { model: 'Org', id: 'id', parent: { resource: 'Tenant', column: '' } },
      })
    ).toThrow(/parent reference has empty column/)
  })

  it('detects cycles in the resource tree', () => {
    expect(() =>
      defineResources({
        A: { model: 'A', id: 'id', children: ['B'], parent: { resource: 'C', column: 'cId' } },
        B: { model: 'B', id: 'id', children: ['C'], parent: { resource: 'A', column: 'aId' } },
        C: { model: 'C', id: 'id', children: ['A'], parent: { resource: 'B', column: 'bId' } },
      })
    ).toThrow(/cycle detected in resource tree/)
  })
})
