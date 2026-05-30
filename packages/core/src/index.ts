/**
 * `@flowchestra/prisma-guarddog-core` — policy compiler primitives.
 *
 * Phase 1 surface: type-safe declarative primitives that produce typed AST
 * values consumed by emitters, importers, and the CLI.
 *
 * The `Guarddog` class composes the four primitives ([[ADR-0003]]) into a
 * policy registry. `.model().policy().{select,insert,update,delete}` author
 * per-verb predicates with explicit USING / WITH CHECK separation per
 * ADR-0005. `.columnPrivileges()`, `.polymorphic()`, `.noPolicy()`, and the
 * `.emit / .diff / .migrate` lifecycle land in subsequent commits per
 * docs/PLAN.md.
 */

export { defineClaims } from './claims.js'
export type { ClaimBuilder, ClaimField, ClaimKind, ClaimsDefinition, ClaimsShape, InferClaims } from './claims.js'

export { defineDbRoles } from './db-roles.js'
export type { DbRoleSpec, DbRolesDefinition } from './db-roles.js'

export { defineAppRoles } from './app-roles.js'
export type { AppRoleSpec, AppRolesDefinition } from './app-roles.js'

export { defineResources } from './resources.js'
export type { ResourceParentRef, ResourceSpec, ResourceTreeDefinition } from './resources.js'

export { defineResourceGrants } from './resource-grants.js'
export type {
  GroupMemberTable,
  PerResourceGrantTable,
  PolymorphicGrantTable,
  ResourceGrantsDefinition,
  ResourceGrantsSource,
} from './resource-grants.js'

export { defineFunctions, orderFunctions } from './function-defs.js'
export type {
  FunctionArg,
  FunctionDefinition,
  FunctionLanguage,
  FunctionParallel,
  FunctionSecurity,
  FunctionsDefinition,
  FunctionVolatility,
} from './function-defs.js'

export { defineSchema, materializeSchema } from './schema.js'
export type { ColumnUnionMap, SchemaDefinition } from './schema.js'

export { Guarddog, ModelBuilder, PolicyBuilder, RestrictivePolicyBuilder } from './guarddog.js'
export type { GuarddogConfig } from './guarddog.js'

export { PolymorphicBuilder, PolymorphicTargetBuilder, PolymorphicTargetPolicyBuilder } from './polymorphic.js'

export { col, FluentExpr, PredicateBuilder } from './predicate.js'

export type {
  AllSpec,
  BinaryOp,
  ColumnPrivilegeAst,
  ColumnPrivilegeGrant,
  DeleteSpec,
  Expr,
  InsertSpec,
  LiteralValue,
  NoPolicyAst,
  PolicyAst,
  PolymorphicAst,
  PolymorphicTargetAst,
  PolymorphicTargetPolicyAst,
  SelectSpec,
  UpdateSpec,
  Verb,
} from './ast.js'

export { defaultTableResolver, policyName, snakeCase } from './naming.js'

export {
  applyOps,
  columnGrantKey,
  empty,
  functionGrantKey,
  functionKey,
  policyMapKey,
  roleMembershipKey,
} from './ops.js'
export type {
  ColumnGrantRecord,
  ColumnVerb,
  FunctionArgRecord,
  FunctionGrantRecord,
  FunctionOpRecord,
  Op,
  PolicyOpRecord,
  RoleMembershipRecord,
  RoleRecord,
  State,
} from './ops.js'

export { compileToOps, compileToState, diffStates } from './lifecycle.js'
export type { CompileOptions, CoverageSummary, GuarddogLike } from './lifecycle.js'
