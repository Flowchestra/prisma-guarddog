/**
 * `defineSchema` — the canonical entry point for the guarddog schema file.
 *
 * Per ADR-0018, the user's primary interface is a TypeScript schema file
 * (conventionally `prisma/guarddog.ts`) that `export default`s a value built
 * by this function. The CLI auto-discovers the file, calls `materializeSchema`
 * to instantiate a `Guarddog` and register policies, then emits.
 *
 * Consumers should think in terms of `defineSchema`. They should *not*
 * instantiate `Guarddog` directly — that class is a runtime implementation
 * detail used by the CLI and extensions.
 *
 *     // prisma/guarddog.ts
 *     import {
 *       defineSchema,
 *       defineClaims, defineDbRoles, defineAppRoles,
 *       defineResources, defineResourceGrants,
 *       col,
 *     } from '@flowchestra/prisma-guarddog'
 *
 *     export default defineSchema({
 *       claims:         defineClaims({ ... }),
 *       dbRoles:        defineDbRoles({ ... }),
 *       appRoles:       defineAppRoles({ ... }),
 *       resources:      defineResources({ ... }),
 *       resourceGrants: defineResourceGrants({ actions: [...] as const }),
 *
 *       policies(guard) {
 *         guard.model('Workbench').policy('app_user')
 *           .select(p => p.hasGrant('read', col('workspaceId')))
 *         // ...
 *       },
 *     })
 */

import type { AppRolesDefinition } from './app-roles.js'
import type { ClaimsDefinition, ClaimsShape } from './claims.js'
import type { DbRolesDefinition } from './db-roles.js'
import type { FunctionDefinition, FunctionsDefinition } from './function-defs.js'
import { Guarddog } from './guarddog.js'
import type { ResourceGrantsDefinition } from './resource-grants.js'
import type { ResourceTreeDefinition } from './resources.js'

/**
 * The declarative schema value the user `export default`s from
 * `prisma/guarddog.ts`. All five primitives plus a policies callback that
 * receives the materialized `Guarddog` instance.
 */
export interface SchemaDefinition<
  TClaimsShape extends ClaimsShape = ClaimsShape,
  TDbRoles extends string = string,
  TAppRoles extends string = string,
  TResources extends string = string,
  TActions extends string = string,
  TGrantTableKeys extends string = string,
  TFunctions extends Record<string, FunctionDefinition> = Record<string, FunctionDefinition>,
> {
  readonly claims: ClaimsDefinition<TClaimsShape>
  readonly dbRoles: DbRolesDefinition<TDbRoles>
  readonly appRoles: AppRolesDefinition<TAppRoles>
  readonly resources: ResourceTreeDefinition<TResources>
  /** Optional layer-3 declaration. Required only if any policy uses `p.hasGrant(...)`. */
  readonly resourceGrants?: ResourceGrantsDefinition<TActions, TGrantTableKeys>
  /**
   * Optional guarddog-managed SQL functions (ADR-0026). Required only if any
   * policy uses `p.fn(...)`. The function-name union flows to the policies
   * callback so `p.fn(name, ...)` autocompletes and arity is checked.
   */
  readonly functions?: FunctionsDefinition<TFunctions>
  /**
   * Policy authoring callback. Receives a Guarddog instance with the four
   * primitives + resourceGrants + functions already wired. The callback
   * registers policies via `guard.model(...).policy(...)`,
   * `guard.polymorphic(...)`, `guard.noPolicy(...)`, etc. The grant-table key
   * union flows here so `p.hasGrant(..., { table })` autocompletes (ADR-0025 /
   * #12); the function-name union flows for `p.fn(...)` (ADR-0026 / #15).
   *
   * Called exactly once per `materializeSchema` invocation. Should be
   * referentially transparent — no side effects, no I/O.
   */
  readonly policies: (
    guard: Guarddog<TClaimsShape, TDbRoles, TAppRoles, TResources, TActions, TGrantTableKeys, TFunctions>
  ) => void
}

/**
 * Declare a guarddog schema. Captures the primitives + policies callback
 * into a frozen value the CLI / generator can consume.
 *
 * Validation happens at materialization time (when the CLI invokes the
 * policies callback). `defineSchema` itself is a pass-through plus a deep
 * freeze — failure here would mean a typo in a const, which the TS layer
 * already catches.
 */
export function defineSchema<
  TClaimsShape extends ClaimsShape,
  TDbRoles extends string,
  TAppRoles extends string,
  TResources extends string,
  TActions extends string = string,
  TGrantTableKeys extends string = string,
  TFunctions extends Record<string, FunctionDefinition> = Record<string, FunctionDefinition>,
>(
  schema: SchemaDefinition<TClaimsShape, TDbRoles, TAppRoles, TResources, TActions, TGrantTableKeys, TFunctions>
): SchemaDefinition<TClaimsShape, TDbRoles, TAppRoles, TResources, TActions, TGrantTableKeys, TFunctions> {
  return Object.freeze({ ...schema })
}

/**
 * Instantiate a `Guarddog` from a declared schema and register every policy.
 * Called by the CLI on `guarddog emit / migrate / check` after loading the
 * user's schema file.
 *
 * Pure function: given the same schema, returns a Guarddog with the same
 * policy set. No I/O. No global state. Safe to call repeatedly (each call
 * yields a fresh instance).
 */
export function materializeSchema<
  TClaimsShape extends ClaimsShape,
  TDbRoles extends string,
  TAppRoles extends string,
  TResources extends string,
  TActions extends string,
  TGrantTableKeys extends string = string,
  TFunctions extends Record<string, FunctionDefinition> = Record<string, FunctionDefinition>,
>(
  schema: SchemaDefinition<TClaimsShape, TDbRoles, TAppRoles, TResources, TActions, TGrantTableKeys, TFunctions>
): Guarddog<TClaimsShape, TDbRoles, TAppRoles, TResources, TActions, TGrantTableKeys, TFunctions> {
  const guard = new Guarddog<TClaimsShape, TDbRoles, TAppRoles, TResources, TActions, TGrantTableKeys, TFunctions>({
    claims: schema.claims,
    dbRoles: schema.dbRoles,
    appRoles: schema.appRoles,
    resources: schema.resources,
    ...(schema.resourceGrants !== undefined && { resourceGrants: schema.resourceGrants }),
    ...(schema.functions !== undefined && { functions: schema.functions }),
  })
  schema.policies(guard)
  return guard
}
