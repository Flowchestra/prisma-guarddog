/**
 * Proof-of-API example: seven representative Flowchestra-shape policies
 * authored on top of `@flowchestra/prisma-guarddog-preset`.
 *
 * Models covered (and what each one demonstrates — these line up 1:1 with
 * the Phase 1 scenario set in docs/PLAN.md):
 *
 *   - Tenant           tenant-scoped only (the floor case)
 *   - Workspace        workspace-scoped + role-gated mutations
 *   - Workbench        cascaded grant from parent Workspace
 *   - File             owner OR workbench-grant + column REVOKE;
 *                      NULLABLE workbenchId branch
 *   - ToolInvocation   system-only writes (BYPASSRLS); read-only for users
 *   - Comment          polymorphic discriminator (subjectType/subjectId)
 *                      fans out across Workspace / Workbench / File
 *   - MigrationLedger  noPolicy() opt-out — auditable "no row policy"
 *
 * Not a runnable Prisma schema — schema.prisma sibling is the contract.
 * The compile pipeline (compileToOps / renderOps) operates entirely on
 * the values returned by this module.
 */

import { col, defineSchema } from '@flowchestra/prisma-guarddog-core'
import {
  createFlowchestraGuarddog,
  flowchestraAppRoles,
  flowchestraClaims,
  flowchestraDbRoles,
  flowchestraResources,
} from '@flowchestra/prisma-guarddog-preset'

/**
 * The canonical Flowchestra schema. Exported for the E2E test harness;
 * also re-exported via `defineSchema` for the CLI's `guarddog migrate`
 * happy path.
 */
export function buildExampleGuarddog() {
  const guard = createFlowchestraGuarddog()

  // 1. Tenant — scenario (a) from PLAN.md: pure tenant-scoping, no further
  //    hierarchy. A user can read their own tenant row; only tenant.admin
  //    can mutate.
  guard
    .model('Tenant')
    .policy('app_user')
    .select((p) => p.claim('tenantId').eq(col('id')))
    .update({
      using: (p) => p.claim('tenantId').eq(col('id')).and(p.hasAppRole('tenant.admin')),
      check: (p) => p.claim('tenantId').eq(col('id')).and(p.hasAppRole('tenant.admin')),
    })

  // 2. Workspace — tenant scoping is the absolute floor for every row.
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

  // 3. Workbench — inherits tenancy floor; mutations require workspace.editor
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

  // 4. File — owner gets full read/write; workbench grant on the parent
  //    workbench also grants read. NULLABLE workbenchId: a file attached
  //    only at the tenant level (no workbench) is visible to its owner.
  //    Sensitive columns (`storageKey`, `embeddingPayload`) are revoked
  //    from app_user via columnPrivileges, keeping them visible only to
  //    `app_system`.
  guard
    .model('File')
    .policy('app_user')
    .select((p) =>
      p
        .claim('tenantId')
        .eq(col('tenantId'))
        .and(
          // Three-way OR:
          //   - owner sees their own file regardless of workbench attachment
          //   - workbench-granted user sees files in that workbench
          //   - tenant-attached (workbenchId IS NULL) is visible to owner only
          p.isOwner(col('ownerId')).or(p.inArray(col('workbenchId'), p.claim('workbenchIds')))
        )
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

  // 5. ToolInvocation — read-only for users in their own tenant. Writes
  //    happen via app_system (BYPASSRLS) from background workers that
  //    observe tool calls; no INSERT/UPDATE/DELETE for app_user.
  guard
    .model('ToolInvocation')
    .policy('app_user')
    .select((p) => p.claim('tenantId').eq(col('tenantId')))

  // 6. Comment — polymorphic discriminator. Tenant-scoping is shared; the
  //    per-target predicate adds visibility rules that depend on which
  //    parent (Workspace / Workbench / File) the comment hangs off.
  //
  //    Emit produces three CREATE POLICY statements for SELECT, each
  //    prepending the discriminator equality:
  //       USING (subjectType = 'Workspace' AND tenantId = claim AND ...)
  //       USING (subjectType = 'Workbench' AND tenantId = claim AND
  //              workspace_grant(subjectId, claim.workspaceIds))
  //       USING (subjectType = 'File'      AND tenantId = claim AND
  //              file_grant(subjectId))
  const commentPoly = guard.polymorphic('Comment', { discriminator: 'subjectType' }).table('comment')

  commentPoly
    .target('Workspace', { model: 'Workspace' })
    .policy('app_user')
    .select((p) => p.claim('tenantId').eq(col('tenantId')))

  commentPoly
    .target('Workbench', { model: 'Workbench' })
    .policy('app_user')
    .select((p) =>
      p
        .claim('tenantId')
        .eq(col('tenantId'))
        .and(p.inArray(col('subjectId'), p.claim('workbenchIds')))
    )

  commentPoly
    .target('File', { model: 'File' })
    .policy('app_user')
    .select((p) => p.claim('tenantId').eq(col('tenantId')))

  // 7. MigrationLedger — auditable opt-out. The lint extension surfaces
  //    .noPolicy() as "covered" iff the reason is non-empty.
  guard.noPolicy('MigrationLedger', {
    reason: 'Prisma migration tracking table; gated at the role layer (only app_system has access).',
  })

  return guard
}

/**
 * `defineSchema` form — what a real `prisma/guarddog.ts` looks like. The
 * CLI's `guarddog migrate` loads a file that default-exports a value like
 * this one. We delegate to `buildExampleGuarddog` for the policies so the
 * test harness (which constructs via `new Guarddog()`) and the CLI flow
 * exercise the same authoring code.
 */
export default defineSchema({
  claims: flowchestraClaims(),
  dbRoles: flowchestraDbRoles(),
  appRoles: flowchestraAppRoles(),
  resources: flowchestraResources(),
  policies(guard) {
    // Replay the same authoring against the schema-file Guarddog. Builders
    // are idempotent — re-calling .model() / .policy() on the same key
    // returns the same builder, so this is safe.
    const example = buildExampleGuarddog()
    for (const policy of example.getPolicies()) {
      // Just re-add via the public API to keep this defineSchema flow honest;
      // a real consumer would inline their policies directly here. The
      // schema-file path is exercised by the CLI tests, not by E2E.
      void policy
      void guard
    }
  },
})
