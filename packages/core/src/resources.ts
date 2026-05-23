/**
 * `defineResources` — declare the resource tree.
 *
 * Resources represent organizational levels — `Tenant -> Org -> Workspace ->
 * Workbench` in the canonical example. The tree drives **resource-scope grant
 * cascade**: a grant of `workspace.admin` against workspace `W` propagates to
 * every workbench inside `W` when policies are emitted.
 *
 * This is distinct from dbRole inheritance (`./db-roles.ts`). See
 * docs/adr/0003-four-primitive-split.md.
 *
 * Example:
 *
 *     const resources = defineResources({
 *       Tenant:    { model: 'Tenant',    id: 'id', children: ['Org'] },
 *       Org:       { model: 'Org',       id: 'id',
 *                    parent: { resource: 'Tenant', column: 'tenantId' },
 *                    children: ['Workspace'] },
 *       Workspace: { model: 'Workspace', id: 'id',
 *                    parent: { resource: 'Org', column: 'orgId' },
 *                    children: ['Workbench'] },
 *       Workbench: { model: 'Workbench', id: 'id',
 *                    parent: { resource: 'Workspace', column: 'workspaceId' } },
 *     });
 *
 * The `parent.resource` and `children[]` strings are type-checked: each must
 * be a key of the same `defineResources` call. Forward references are allowed.
 * Cycles, dangling references, and parent/child inconsistencies are rejected
 * at runtime.
 */

export interface ResourceParentRef<TName extends string = string> {
  readonly resource: TName
  readonly column: string
}

export interface ResourceSpec<TName extends string = string> {
  readonly model: string
  readonly id: string
  readonly parent?: ResourceParentRef<TName>
  readonly children: ReadonlyArray<TName>
}

export interface ResourceTreeDefinition<R extends string = string> {
  readonly resources: Readonly<Record<R, ResourceSpec<R>>>
  readonly roots: ReadonlyArray<R>
}

type ResourceInput<TNames extends string> = {
  readonly model: string
  readonly id: string
  readonly parent?: {
    readonly resource: TNames
    readonly column: string
  }
  readonly children?: readonly TNames[]
}

export function defineResources<const T extends Record<string, ResourceInput<Extract<keyof T, string>>>>(
  resources: T
): ResourceTreeDefinition<Extract<keyof T, string>> {
  type R = Extract<keyof T, string>
  const names = new Set<string>(Object.keys(resources))
  const normalized: Record<string, ResourceSpec<R>> = {}

  for (const [name, spec] of Object.entries(resources)) {
    if (spec.model.length === 0) {
      throw new Error(`[prisma-guarddog] defineResources: resource "${name}" has empty model.`)
    }
    if (spec.id.length === 0) {
      throw new Error(`[prisma-guarddog] defineResources: resource "${name}" has empty id column.`)
    }

    if (spec.parent !== undefined) {
      if (!names.has(spec.parent.resource)) {
        throw new Error(
          `[prisma-guarddog] defineResources: resource "${name}" references unknown parent resource "${spec.parent.resource}".`
        )
      }
      if (spec.parent.resource === name) {
        throw new Error(`[prisma-guarddog] defineResources: resource "${name}" cannot be its own parent.`)
      }
      if (spec.parent.column.length === 0) {
        throw new Error(`[prisma-guarddog] defineResources: resource "${name}" parent reference has empty column.`)
      }
    }

    const children = spec.children ?? []
    for (const child of children) {
      if (!names.has(child)) {
        throw new Error(
          `[prisma-guarddog] defineResources: resource "${name}" references unknown child resource "${child}".`
        )
      }
      if (child === name) {
        throw new Error(`[prisma-guarddog] defineResources: resource "${name}" cannot list itself as a child.`)
      }
    }

    normalized[name] = Object.freeze({
      model: spec.model,
      id: spec.id,
      ...(spec.parent !== undefined && {
        parent: Object.freeze({ resource: spec.parent.resource as R, column: spec.parent.column }),
      }),
      children: Object.freeze([...children]) as readonly R[],
    })
  }

  validateParentChildConsistency(normalized)
  detectResourceCycle(normalized)

  const roots = (Object.keys(normalized) as R[]).filter((n) => normalized[n]?.parent === undefined)

  return Object.freeze({
    resources: Object.freeze(normalized) as Readonly<Record<R, ResourceSpec<R>>>,
    roots: Object.freeze(roots),
  })
}

function validateParentChildConsistency(resources: Record<string, ResourceSpec>): void {
  for (const [name, spec] of Object.entries(resources)) {
    for (const child of spec.children) {
      const childSpec = resources[child]
      if (childSpec === undefined) continue
      if (childSpec.parent?.resource !== name) {
        throw new Error(
          `[prisma-guarddog] defineResources: resource "${name}" lists "${child}" as a child, but "${child}".parent does not point back to "${name}".`
        )
      }
    }
    if (spec.parent !== undefined) {
      const parentSpec = resources[spec.parent.resource]
      if (parentSpec !== undefined && !parentSpec.children.includes(name)) {
        throw new Error(
          `[prisma-guarddog] defineResources: resource "${name}" has parent "${spec.parent.resource}", but "${spec.parent.resource}".children does not include "${name}".`
        )
      }
    }
  }
}

function detectResourceCycle(resources: Record<string, ResourceSpec>): void {
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2
  const color = new Map<string, number>()
  for (const name of Object.keys(resources)) color.set(name, WHITE)

  function visit(name: string, path: string[]): void {
    const c = color.get(name)
    if (c === GRAY) {
      throw new Error(
        `[prisma-guarddog] defineResources: cycle detected in resource tree: ${[...path, name].join(' -> ')}`
      )
    }
    if (c === BLACK) return
    color.set(name, GRAY)
    const spec = resources[name]
    if (spec) {
      for (const child of spec.children) {
        visit(child, [...path, name])
      }
    }
    color.set(name, BLACK)
  }

  for (const name of Object.keys(resources)) visit(name, [])
}
