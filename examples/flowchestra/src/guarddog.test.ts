/**
 * Compile-pipeline coverage for the example Flowchestra schema. Verifies:
 *
 *   1. The 5 representative models all show up as either policies or noPolicy
 *      declarations (no missing-coverage gaps).
 *   2. `compileToOps` produces a deterministic op stream containing the
 *      expected verbs per model.
 *   3. `renderOps` emits the expected SQL shapes for create-role,
 *      enable-rls, create-policy, and grant-column.
 *   4. Sidecar round-trip (`applyOps(empty(), compileToOps(...))`) reaches
 *      the same State as `compileToState`.
 *
 * Real-Postgres E2E (in `./e2e-postgres.test.ts`) covers semantic
 * enforcement; this file covers the pure compile/emit path so regressions
 * surface in CI without needing a DB.
 */

import { renderOps } from '@flowchestra/prisma-guarddog'
import { applyOps, compileToOps, compileToState, empty, type Op } from '@flowchestra/prisma-guarddog-core'
import { lintCoverage } from '@flowchestra/prisma-guarddog-lint'
import { describe, expect, it } from 'vitest'

import { buildExampleGuarddog } from '../prisma/guarddog.js'

describe('example flowchestra schema — compile pipeline', () => {
  it('declares the seven representative models', () => {
    const guard = buildExampleGuarddog()
    const modelsWithPolicies = new Set(guard.getPolicies().map((p) => p.model))
    const polymorphicModels = new Set(guard.getPolymorphics().map((p) => p.modelName))
    const noPolicyModels = new Set(guard.getNoPolicies().map((n) => n.model))
    expect(modelsWithPolicies).toContain('Tenant')
    expect(modelsWithPolicies).toContain('Workspace')
    expect(modelsWithPolicies).toContain('Workbench')
    expect(modelsWithPolicies).toContain('File')
    expect(modelsWithPolicies).toContain('ToolInvocation')
    expect(polymorphicModels).toContain('Comment')
    expect(noPolicyModels).toContain('MigrationLedger')
  })

  it('passes lintCoverage against the seven-model Prisma list', () => {
    const guard = buildExampleGuarddog()
    const report = lintCoverage({
      guard,
      prismaModels: [
        { name: 'Tenant' },
        { name: 'Workspace' },
        { name: 'Workbench' },
        { name: 'File' },
        { name: 'ToolInvocation' },
        { name: 'Comment' },
        { name: 'MigrationLedger' },
      ],
    })
    expect(report.ok).toBe(true)
    expect(report.issues.filter((i) => i.severity === 'error')).toHaveLength(0)
  })

  it('compiles to a deterministic op sequence', () => {
    const a = compileToOps(buildExampleGuarddog())
    const b = compileToOps(buildExampleGuarddog())
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('emits create-policy ops for every (model, verb) declared on the policies', () => {
    const ops = compileToOps(buildExampleGuarddog())
    const policyOps = ops.filter((o): o is Extract<Op, { kind: 'create-policy' }> => o.kind === 'create-policy')
    const seen = new Set(policyOps.map((o) => `${o.policy.model}::${o.policy.verb}`))
    expect(seen.has('Workspace::select')).toBe(true)
    expect(seen.has('Workspace::insert')).toBe(true)
    expect(seen.has('Workspace::update')).toBe(true)
    expect(seen.has('Workspace::delete')).toBe(true)
    expect(seen.has('Workbench::select')).toBe(true)
    expect(seen.has('File::update')).toBe(true)
    expect(seen.has('ToolInvocation::select')).toBe(true)
  })

  it('enables and forces RLS on every policied table (no MigrationLedger toggle)', () => {
    const ops = compileToOps(buildExampleGuarddog())
    const enabled = new Set(
      ops.filter((o): o is Extract<Op, { kind: 'enable-rls' }> => o.kind === 'enable-rls').map((o) => o.table)
    )
    const forced = new Set(
      ops.filter((o): o is Extract<Op, { kind: 'force-rls' }> => o.kind === 'force-rls').map((o) => o.table)
    )
    expect(enabled).toEqual(new Set(['tenant', 'workspace', 'workbench', 'file', 'tool_invocation', 'comment']))
    expect(forced).toEqual(enabled)
  })

  it('emits column GRANTs for the sensitive File columns', () => {
    const ops = compileToOps(buildExampleGuarddog())
    const grants = ops.filter((o): o is Extract<Op, { kind: 'grant-column' }> => o.kind === 'grant-column')
    const keys = grants.map((g) => `${g.table}.${g.column}::${g.verb}::${g.role}`).toSorted()
    expect(keys).toEqual([
      'file.embeddingPayload::select::app_system',
      'file.embeddingPayload::update::app_system',
      'file.storageKey::select::app_system',
      'file.storageKey::update::app_system',
    ])
  })

  it('renders SQL with expected hallmarks (role DO-block, CREATE POLICY, GRANT column)', () => {
    const guard = buildExampleGuarddog()
    const sql = renderOps(compileToOps(guard), { claims: guard.config.claims })
    const joined = sql.join('\n')
    expect(joined).toContain('CREATE ROLE app_user')
    expect(joined).toContain('CREATE ROLE app_system')
    expect(joined).toContain('GRANT app_user TO app_system')
    expect(joined).toContain('ALTER TABLE workspace ENABLE ROW LEVEL SECURITY')
    expect(joined).toContain('CREATE POLICY workspace_app_user_select ON workspace FOR SELECT TO app_user')
    expect(joined).toContain('GRANT SELECT ("storageKey") ON file TO app_system')
  })

  it('forward-replay of compileToOps reaches the same State as compileToState', () => {
    const guard = buildExampleGuarddog()
    const replayed = applyOps(empty(), compileToOps(guard))
    const direct = compileToState(guard)
    expect(replayed.policies.size).toBe(direct.policies.size)
    expect(replayed.rlsEnabled.size).toBe(direct.rlsEnabled.size)
    expect(replayed.columnGrants.size).toBe(direct.columnGrants.size)
    expect(replayed.roles.size).toBe(direct.roles.size)
  })
})
