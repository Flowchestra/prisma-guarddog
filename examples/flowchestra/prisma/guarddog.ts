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
 * This file is the canonical user-facing pattern (per ADR-0018): a single
 * `defineSchema({...})` default export with policies authored inline in the
 * `policies(guard)` callback. The CLI's `guarddog migrate` / `check` /
 * `emit` / `diff` all load this default export and materialize it through
 * `materializeSchema`. Tests load it the same way — there is no separate
 * imperative entry point.
 *
 * Not a runnable Prisma schema — schema.prisma sibling is the contract.
 */

import { col, defineSchema } from '@flowchestra/prisma-guarddog-core'
import {
  flowchestraAppRoles,
  flowchestraClaims,
  flowchestraDbRoles,
  flowchestraResources,
} from '@flowchestra/prisma-guarddog-preset'

export default defineSchema({
  claims: flowchestraClaims(),
  dbRoles: flowchestraDbRoles(),
  appRoles: flowchestraAppRoles(),
  resources: flowchestraResources(),
  policies(guard) {
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
  },
})
