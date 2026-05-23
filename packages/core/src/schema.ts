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
> {
  readonly claims: ClaimsDefinition<TClaimsShape>
  readonly dbRoles: DbRolesDefinition<TDbRoles>
  readonly appRoles: AppRolesDefinition<TAppRoles>
  readonly resources: ResourceTreeDefinition<TResources>
  /** Optional layer-3 declaration. Required only if any policy uses `p.hasGrant(...)`. */
  readonly resourceGrants?: ResourceGrantsDefinition<TActions>
  /**
   * Policy authoring callback. Receives a Guarddog instance with the four
   * primitives + resourceGrants already wired. The callback registers
   * policies via `guard.model(...).policy(...)`, `guard.polymorphic(...)`,
   * `guard.noPolicy(...)`, etc.
   *
   * Called exactly once per `materializeSchema` invocation. Should be
   * referentially transparent — no side effects, no I/O.
   */
  readonly policies: (guard: Guarddog<TClaimsShape, TDbRoles, TAppRoles, TResources, TActions>) => void
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
>(
  schema: SchemaDefinition<TClaimsShape, TDbRoles, TAppRoles, TResources, TActions>
): SchemaDefinition<TClaimsShape, TDbRoles, TAppRoles, TResources, TActions> {
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
>(
  schema: SchemaDefinition<TClaimsShape, TDbRoles, TAppRoles, TResources, TActions>
): Guarddog<TClaimsShape, TDbRoles, TAppRoles, TResources, TActions> {
  const guard = new Guarddog<TClaimsShape, TDbRoles, TAppRoles, TResources, TActions>({
    claims: schema.claims,
    dbRoles: schema.dbRoles,
    appRoles: schema.appRoles,
    resources: schema.resources,
    ...(schema.resourceGrants !== undefined && { resourceGrants: schema.resourceGrants }),
  })
  schema.policies(guard)
  return guard
}
