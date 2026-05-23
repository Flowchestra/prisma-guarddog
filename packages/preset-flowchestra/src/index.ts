/**
 * `@prisma-guarddog/preset-flowchestra` — opinionated preset for Flowchestra.
 *
 * Bundles the WorkOS JWT claim shape, the `app_user` / `app_system` dbRole
 * pair, the canonical `org.*` / `workspace.*` / `workbench.*` appRoles, and
 * the `Tenant -> Workspace -> Workbench` resource tree into one factory.
 *
 * If you are not Flowchestra, do not import this — compose your own preset
 * by calling the primitives in `@prisma-guarddog/core` directly. See
 * ADR-0011 for the extraction policy that keeps `core` engagement-neutral.
 *
 * Three usage shapes:
 *
 *   1. Component pieces — pass to `defineSchema({ claims: flowchestraClaims(), ... })`
 *      when you want to override only some defaults.
 *
 *   2. `createFlowchestraGuarddog()` — instantiate a ready-to-author Guarddog
 *      with claims/dbRoles/appRoles/resources already installed.
 *
 *   3. Layer in extras: `createFlowchestraGuarddog({ extraAppRoles: { ... } })`
 *      adds new appRoles alongside the defaults.
 */

import {
  type AppRolesDefinition,
  type ClaimsDefinition,
  type DbRolesDefinition,
  defineAppRoles,
  defineClaims,
  defineDbRoles,
  defineResources,
  Guarddog,
  type ResourceTreeDefinition,
} from '@prisma-guarddog/core'

export const FLOWCHESTRA_DEFAULT_CLAIMS_ACCESSOR = 'request.jwt.claims'

/**
 * Canonical WorkOS-flavored claim shape. Override the `accessor` if your
 * deployment routes JWT claims through a different `current_setting()`
 * key (Supabase's default is `request.jwt.claims`; PostgREST and some
 * RDS+JWT setups vary).
 */
export function flowchestraClaims(opts: { readonly accessor?: string } = {}) {
  return defineClaims({
    accessor: opts.accessor ?? FLOWCHESTRA_DEFAULT_CLAIMS_ACCESSOR,
    shape: (c) => ({
      sub: c.uuid(),
      tenantId: c.uuid(),
      workspaceIds: c.array(c.uuid()),
      workbenchIds: c.array(c.uuid()),
      roles: c.array(c.string()),
    }),
  })
}

/**
 * `app_user` — the role every authenticated request runs under.
 * `app_system` — privileged role for system jobs; inherits `app_user`
 * and carries `BYPASSRLS` so background workers can write across tenants
 * when their explicit `__systemContext` flow needs it.
 */
export function flowchestraDbRoles() {
  return defineDbRoles({
    app_user: { inherits: [], nologin: true },
    app_system: { inherits: ['app_user'], bypassesRls: true, nologin: true },
  })
}

/**
 * Standard appRole vocabulary. Predicates in user-authored policies call
 * `p.hasAppRole('workspace.admin')` against these names. Add product-
 * specific roles via `extraAppRoles` on `createFlowchestraGuarddog`.
 */
export function flowchestraAppRoles() {
  return defineAppRoles({
    'tenant.admin': {},
    'workspace.admin': {},
    'workspace.editor': {},
    'workspace.viewer': {},
    'workbench.admin': {},
    'workbench.editor': {},
    'workbench.viewer': {},
  })
}

/**
 * Canonical Flowchestra resource tree: tenants own workspaces; workspaces
 * own workbenches. The hierarchy is intentionally flat (no Org tier) —
 * Flowchestra's product model puts workspaces directly under tenant; see
 * the Flowchestra org-architecture decisions memory.
 */
export function flowchestraResources() {
  return defineResources({
    Tenant: { model: 'Tenant', id: 'id', children: ['Workspace'] },
    Workspace: {
      model: 'Workspace',
      id: 'id',
      parent: { resource: 'Tenant', column: 'tenantId' },
      children: ['Workbench'],
    },
    Workbench: {
      model: 'Workbench',
      id: 'id',
      parent: { resource: 'Workspace', column: 'workspaceId' },
    },
  })
}

export interface CreateFlowchestraGuarddogOptions {
  /** Override the `current_setting()` accessor for JWT claims. */
  readonly claimsAccessor?: string
}

/**
 * Instantiate a Guarddog wired with every Flowchestra preset. Add models,
 * policies, polymorphics, and column privileges by chaining off the
 * returned instance — same surface as `new Guarddog({...})` would expose
 * directly.
 */
export function createFlowchestraGuarddog(
  opts: CreateFlowchestraGuarddogOptions = {}
): Guarddog<
  ReturnType<typeof flowchestraClaims> extends ClaimsDefinition<infer S> ? S : never,
  ReturnType<typeof flowchestraDbRoles> extends DbRolesDefinition<infer R> ? R : never,
  ReturnType<typeof flowchestraAppRoles> extends AppRolesDefinition<infer A> ? A : never,
  ReturnType<typeof flowchestraResources> extends ResourceTreeDefinition<infer T> ? T : never,
  string
> {
  return new Guarddog({
    claims: flowchestraClaims(opts.claimsAccessor !== undefined ? { accessor: opts.claimsAccessor } : {}),
    dbRoles: flowchestraDbRoles(),
    appRoles: flowchestraAppRoles(),
    resources: flowchestraResources(),
  }) as never
}
