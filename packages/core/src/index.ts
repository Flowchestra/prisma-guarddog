/**
 * `@prisma-guarddog/core` — policy compiler primitives.
 *
 * Phase 1 surface: type-safe declarative primitives that produce typed AST
 * values consumed by emitters, importers, and the CLI.
 *
 * Implementation in progress per docs/PLAN.md. The `Guarddog` constructor,
 * policy builders (`.model`, `.policy`, `.columnPrivileges`, `.polymorphic`,
 * `.noPolicy`, `.rawSql`), and the `.emit` / `.diff` / `.migrate` lifecycle
 * land in subsequent commits.
 */

export { defineClaims } from './claims.js'
export type { ClaimBuilder, ClaimField, ClaimKind, ClaimsDefinition, ClaimsShape, InferClaims } from './claims.js'

export { defineDbRoles } from './db-roles.js'
export type { DbRoleSpec, DbRolesDefinition } from './db-roles.js'

export { defineBusinessRoles } from './business-roles.js'
export type { BusinessRoleSpec, BusinessRolesDefinition } from './business-roles.js'

export { defineResources } from './resources.js'
export type { ResourceParentRef, ResourceSpec, ResourceTreeDefinition } from './resources.js'
