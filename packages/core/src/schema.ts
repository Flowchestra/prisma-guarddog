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

/** Map the generated `ModelColumns` const (model -> column tuple) to the model -> column-union form. */
export type ColumnUnionMap<T extends Record<string, readonly string[]>> = {
  readonly [K in keyof T]: T[K][number]
}

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
  TModels extends Record<string, string> = Record<string, string>,
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
   * Optional model -> SQL columns map — pass the generated `ModelColumns`
   * const. Wires typed `guard.model(...)` + `p.col(...)` (ADR-0028); the
   * column union is inferred from the const, so no explicit generic is
   * needed. Omit it and `model()` / `p.col()` stay unconstrained (`string`).
   */
  readonly models?: Record<string, readonly string[]>
  /**
   * Policy authoring callback. Receives a Guarddog instance with the four
   * primitives + resourceGrants + functions + models already wired. The
   * callback registers policies via `guard.model(...).policy(...)`,
   * `guard.polymorphic(...)`, `guard.noPolicy(...)`, etc. The grant-table key
   * union flows here so `p.hasGrant(..., { table })` autocompletes (ADR-0025 /
   * #12); the function-name union flows for `p.fn(...)` (ADR-0026 / #15); the
   * model + column unions flow for `model(...)` / `p.col(...)` (ADR-0028).
   *
   * Called exactly once per `materializeSchema` invocation. Should be
   * referentially transparent — no side effects, no I/O.
   */
  readonly policies: (
    guard: Guarddog<TClaimsShape, TDbRoles, TAppRoles, TResources, TActions, TGrantTableKeys, TFunctions, TModels>
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
  TModelColumns extends Record<string, readonly string[]> = Record<string, readonly string[]>,
>(
  // `TModelColumns` is inferred from the `models` const (the generated
  // `ModelColumns`); it maps to the model -> column-union form the rest of
  // the API consumes (ADR-0028). The `Omit` + intersection carries the
  // precise const type into inference without widening it.
  schema: Omit<
    SchemaDefinition<
      TClaimsShape,
      TDbRoles,
      TAppRoles,
      TResources,
      TActions,
      TGrantTableKeys,
      TFunctions,
      ColumnUnionMap<TModelColumns>
    >,
    'models'
  > & { readonly models?: TModelColumns }
): SchemaDefinition<
  TClaimsShape,
  TDbRoles,
  TAppRoles,
  TResources,
  TActions,
  TGrantTableKeys,
  TFunctions,
  ColumnUnionMap<TModelColumns>
> {
  return Object.freeze({ ...schema }) as SchemaDefinition<
    TClaimsShape,
    TDbRoles,
    TAppRoles,
    TResources,
    TActions,
    TGrantTableKeys,
    TFunctions,
    ColumnUnionMap<TModelColumns>
  >
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
  TModels extends Record<string, string> = Record<string, string>,
>(
  schema: SchemaDefinition<
    TClaimsShape,
    TDbRoles,
    TAppRoles,
    TResources,
    TActions,
    TGrantTableKeys,
    TFunctions,
    TModels
  >
): Guarddog<TClaimsShape, TDbRoles, TAppRoles, TResources, TActions, TGrantTableKeys, TFunctions, TModels> {
  const guard = new Guarddog<
    TClaimsShape,
    TDbRoles,
    TAppRoles,
    TResources,
    TActions,
    TGrantTableKeys,
    TFunctions,
    TModels
  >({
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
