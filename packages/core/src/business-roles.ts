/**
 * `defineBusinessRoles` — declare the application-level role names that may
 * appear in claim predicates.
 *
 * businessRoles are strings carried in JWT claims (e.g., `workspace.admin`,
 * `workbench.editor`). They are NOT Postgres roles — they are evaluated by
 * predicates inside emitted `USING` / `WITH CHECK` clauses against the
 * session's claims. See docs/adr/0003-four-primitive-split.md.
 *
 * The value side is intentionally an empty marker object for now; future
 * versions may carry per-role metadata (e.g., implied actions, friendly
 * labels) without breaking existing call sites.
 *
 * Example:
 *
 *     const businessRoles = defineBusinessRoles({
 *       'org.admin':         {},
 *       'workspace.admin':   {},
 *       'workspace.editor':  {},
 *       'workbench.admin':   {},
 *       'workbench.editor':  {},
 *     });
 */

export interface BusinessRoleSpec {
  // Phase 1: intentionally empty. Reserved for future metadata.
}

export interface BusinessRolesDefinition<R extends string = string> {
  readonly roles: Readonly<Record<R, BusinessRoleSpec>>
}

export function defineBusinessRoles<const T extends Record<string, BusinessRoleSpec>>(
  roles: T
): BusinessRolesDefinition<Extract<keyof T, string>> {
  type R = Extract<keyof T, string>
  const normalized: Record<string, BusinessRoleSpec> = {}
  for (const name of Object.keys(roles)) {
    if (name.length === 0) {
      throw new Error('[prisma-guarddog] defineBusinessRoles: role name must be a non-empty string.')
    }
    normalized[name] = Object.freeze({})
  }
  return Object.freeze({
    roles: Object.freeze(normalized) as Readonly<Record<R, BusinessRoleSpec>>,
  })
}
