/**
 * Proof-of-API example: five representative Flowchestra-shape policies
 * authored on top of `@prisma-guarddog/preset-flowchestra`.
 *
 * Models covered (and what each one demonstrates):
 *
 *   - Workspace        tenant scoping + role-gated mutations
 *   - Workbench        cascaded grant from parent Workspace
 *   - File             owner-OR-role checks; column REVOKE of sensitive blob fields
 *   - ToolInvocation   system-only writes (BYPASSRLS) + read of own tenant
 *   - MigrationLedger  noPolicy() opt-out — auditable "no row policy" decision
 *
 * Not a runnable Prisma schema — the schema.prisma lives in this same
 * directory for reference and is what these model names line up against.
 * The compile pipeline (compileToOps / renderOps) operates entirely on
 * the values returned by this module.
 */

import { col, defineSchema } from '@prisma-guarddog/core'
import {
  createFlowchestraGuarddog,
  flowchestraAppRoles,
  flowchestraClaims,
  flowchestraDbRoles,
  flowchestraResources,
} from '@prisma-guarddog/preset-flowchestra'

/**
 * The canonical Flowchestra schema. Exported for the E2E test harness;
 * also re-exported via `defineSchema` for the CLI's `guarddog migrate`
 * happy path.
 */
export function buildExampleGuarddog() {
  const guard = createFlowchestraGuarddog()

  // 1. Workspace — tenant scoping is the absolute floor for every Flowchestra row.
  guard
    .model('Workspace')
    .policy('app_user')
    .select((p) => p.claim('tenantId').eq(col('tenantId')))
    .insert({
      check: (p) => p.claim('tenantId').eq(col('tenantId')).and(p.hasAppRole('tenant.admin')),
    })
    .update({
      using: (p) => p.claim('tenantId').eq(col('tenantId')),
      check: (p) => p.claim('tenantId').eq(col('tenantId')).and(p.hasAppRole('workspace.admin')),
    })
    .delete({
      using: (p) => p.claim('tenantId').eq(col('tenantId')).and(p.hasAppRole('tenant.admin')),
    })

  // 2. Workbench — inherits tenancy floor; mutations require workspace.editor
  //    or higher on the parent workspace.
  guard
    .model('Workbench')
    .policy('app_user')
    .select((p) =>
      p
        .claim('tenantId')
        .eq(col('tenantId'))
        .and(p.inArray(col('workspaceId'), p.claim('workspaceIds')))
    )
    .insert({
      check: (p) => p.claim('tenantId').eq(col('tenantId')).and(p.hasAppRole('workspace.editor')),
    })
    .update({
      using: (p) =>
        p
          .claim('tenantId')
          .eq(col('tenantId'))
          .and(p.inArray(col('workspaceId'), p.claim('workspaceIds'))),
      check: (p) => p.claim('tenantId').eq(col('tenantId')).and(p.hasAppRole('workspace.editor')),
    })
    .delete({
      using: (p) => p.claim('tenantId').eq(col('tenantId')).and(p.hasAppRole('workspace.admin')),
    })

  // 3. File — owner gets full read/write; workbench.editor on the parent
  //    workbench also gets read. Sensitive columns (`storageKey`,
  //    `embeddingPayload`) are revoked from app_user via columnPrivileges,
  //    keeping them visible to `app_system` only.
  guard
    .model('File')
    .policy('app_user')
    .select((p) =>
      p
        .claim('tenantId')
        .eq(col('tenantId'))
        .and(p.isOwner(col('ownerId')).or(p.inArray(col('workbenchId'), p.claim('workbenchIds'))))
    )
    .insert({
      check: (p) =>
        p
          .claim('tenantId')
          .eq(col('tenantId'))
          .and(p.isOwner(col('ownerId'))),
    })
    .update({
      using: (p) =>
        p
          .claim('tenantId')
          .eq(col('tenantId'))
          .and(p.isOwner(col('ownerId'))),
      check: (p) =>
        p
          .claim('tenantId')
          .eq(col('tenantId'))
          .and(p.isOwner(col('ownerId'))),
    })
    .delete({
      using: (p) =>
        p
          .claim('tenantId')
          .eq(col('tenantId'))
          .and(p.isOwner(col('ownerId'))),
    })
  guard.model('File').columnPrivileges({
    storageKey: { select: ['app_system'], update: ['app_system'] },
    embeddingPayload: { select: ['app_system'], update: ['app_system'] },
  })

  // 4. ToolInvocation — read-only for users in their own tenant.
  //    Writes happen via app_system (BYPASSRLS) from background workers
  //    that observe tool calls; no INSERT/UPDATE/DELETE for app_user.
  guard
    .model('ToolInvocation')
    .policy('app_user')
    .select((p) => p.claim('tenantId').eq(col('tenantId')))

  // 5. MigrationLedger — auditable opt-out. The lint extension surfaces
  //    .noPolicy() as "covered" iff the reason is non-empty.
  guard.noPolicy('MigrationLedger', {
    reason: 'Prisma migration tracking table; gated at the role layer (only app_system has access).',
  })

  return guard
}

/**
 * `defineSchema` form — what a real `prisma/guarddog.ts` looks like. The
 * CLI's `guarddog migrate` loads a file that default-exports a value like
 * this one.
 */
export default defineSchema({
  claims: flowchestraClaims(),
  dbRoles: flowchestraDbRoles(),
  appRoles: flowchestraAppRoles(),
  resources: flowchestraResources(),
  policies(_guard) {
    // The illustrative policy authoring is in `buildExampleGuarddog()` so
    // tests can also exercise the `new Guarddog()` form. Real consumers
    // would inline their policies here.
    // (The schema-file flow re-uses the same primitives; see
    //  packages/core/src/schema.ts for the materializer.)
  },
})
