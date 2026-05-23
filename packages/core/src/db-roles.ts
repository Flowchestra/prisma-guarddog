/**
 * `defineDbRoles` — declare the Postgres roles guarddog will emit policies
 * against and grants for.
 *
 * dbRoles are real Postgres roles created via `CREATE ROLE`. They are the
 * principals on the `FOR ALL TO <role>` side of every emitted `CREATE POLICY`.
 *
 * dbRole inheritance is *structural Postgres inheritance* — distinct from
 * resource-scope cascade (see `./resources.ts`) and app-role evaluation
 * (see `./app-roles.ts`). See docs/adr/0003-four-primitive-split.md.
 *
 * Example:
 *
 *     const dbRoles = defineDbRoles({
 *       app_user:   { inherits: [] },
 *       app_system: { inherits: ['app_user'], bypassesRls: true },
 *     });
 *
 * The `inherits` array is type-checked: every entry must be a key of the same
 * `defineDbRoles` call. Forward references are allowed (`app_user` could
 * inherit from `app_system` declared below it), but cycles are rejected at
 * runtime.
 */

export interface DbRoleSpec<TName extends string = string> {
  readonly inherits: ReadonlyArray<TName>
  readonly bypassesRls?: boolean
  readonly nologin?: boolean
}

export interface DbRolesDefinition<R extends string = string> {
  readonly roles: Readonly<Record<R, DbRoleSpec<R>>>
}

type DbRoleInput<TNames extends string> = {
  readonly inherits?: readonly TNames[]
  readonly bypassesRls?: boolean
  readonly nologin?: boolean
}

export function defineDbRoles<const T extends Record<string, DbRoleInput<Extract<keyof T, string>>>>(
  roles: T
): DbRolesDefinition<Extract<keyof T, string>> {
  type R = Extract<keyof T, string>
  const known = new Set<string>(Object.keys(roles))
  const normalized: Record<string, DbRoleSpec<R>> = {}

  for (const [name, spec] of Object.entries(roles)) {
    const inherits = spec.inherits ?? []
    for (const parent of inherits) {
      if (!known.has(parent)) {
        throw new Error(
          `[prisma-guarddog] defineDbRoles: role "${name}" inherits from "${parent}", but "${parent}" is not defined in the same call.`
        )
      }
      if (parent === name) {
        throw new Error(`[prisma-guarddog] defineDbRoles: role "${name}" cannot inherit from itself.`)
      }
    }
    normalized[name] = Object.freeze({
      inherits: Object.freeze([...inherits]) as readonly R[],
      ...(spec.bypassesRls !== undefined && { bypassesRls: spec.bypassesRls }),
      ...(spec.nologin !== undefined && { nologin: spec.nologin }),
    })
  }

  detectInheritanceCycle(normalized)

  return Object.freeze({
    roles: Object.freeze(normalized) as Readonly<Record<R, DbRoleSpec<R>>>,
  })
}

function detectInheritanceCycle(roles: Record<string, DbRoleSpec>): void {
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2
  const color = new Map<string, number>()
  for (const name of Object.keys(roles)) color.set(name, WHITE)

  function visit(name: string, path: string[]): void {
    const c = color.get(name)
    if (c === GRAY) {
      throw new Error(`[prisma-guarddog] defineDbRoles: inheritance cycle detected: ${[...path, name].join(' -> ')}`)
    }
    if (c === BLACK) return
    color.set(name, GRAY)
    const spec = roles[name]
    if (spec) {
      for (const parent of spec.inherits) {
        visit(parent, [...path, name])
      }
    }
    color.set(name, BLACK)
  }

  for (const name of Object.keys(roles)) visit(name, [])
}
