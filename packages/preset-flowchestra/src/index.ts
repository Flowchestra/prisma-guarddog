/**
 * `@prisma-guarddog/preset-flowchestra` — opinionated preset for Flowchestra.
 *
 * Phase 1 surface (implementation pending):
 *   - `createFlowchestraGuarddog({ prisma, claimsAccessor })`
 *   - Wires the WorkOS JWT claim shape (tenantId, orgId, workspaceId,
 *     workbenchId, roles, permissions)
 *   - Wires the `app_user` / `app_system` dbRole hierarchy
 *   - Wires the conventional Tenant -> Org -> Workspace -> Workbench
 *     resource tree
 *
 * If you are not Flowchestra, do not import this. Compose your own preset by
 * calling `new Guarddog({...})` directly from `@prisma-guarddog/core`.
 *
 * See ADR-0011.
 */

export {};
