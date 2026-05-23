/**
 * Render an `Op[]` sequence (from `core.diffStates` or `core.compileToOps`)
 * into a flat array of idempotent Postgres DDL statements.
 *
 * This is the bridge between core's intent-level Op union and the dialect
 * emitter packages. Each Op kind maps to a small bit of SQL — for
 * `create-policy` we delegate the predicate compilation to
 * `@flowchestra/prisma-guarddog-emitter-postgres-rls`'s `compileExpr`; the surrounding
 * DROP/CREATE scaffold is inlined here because it's trivial and avoids
 * forcing the per-policy emitter API to support Op input.
 *
 * Self-contained per the emission principle: nothing requires consumer SQL
 * helpers. CREATE POLICY is always preceded by DROP POLICY IF EXISTS (so
 * forward replay and idempotent re-runs both work). CREATE ROLE / GRANT
 * membership use the DO-block patterns from `emitRoles` for safety across
 * Postgres versions.
 */

import type {
  ClaimsDefinition,
  ColumnVerb,
  Op,
  PolicyOpRecord,
  ResourceGrantsDefinition,
  Verb,
} from '@flowchestra/prisma-guarddog-core'
import {
  compileExpr,
  type ExprCompileCtx,
  type HasAppRoleCompiler,
  type HasGrantCompiler,
  type HasResourcePermissionCompiler,
  type IsOwnerCompiler,
  quoteIdent,
  quoteString,
} from '@flowchestra/prisma-guarddog-emitter-postgres-rls'

export interface RenderContext {
  readonly claims: ClaimsDefinition
  readonly resourceGrants?: ResourceGrantsDefinition
  readonly compileHasAppRole?: HasAppRoleCompiler
  readonly compileHasGrant?: HasGrantCompiler
  readonly compileHasResourcePermission?: HasResourcePermissionCompiler
  readonly compileIsOwner?: IsOwnerCompiler
}

/**
 * Render a sequence of ops to SQL. Ops are processed in input order; the
 * caller (diff or compile) is responsible for producing a safe ordering.
 */
export function renderOps(ops: ReadonlyArray<Op>, ctx: RenderContext): readonly string[] {
  const out: string[] = []
  for (const op of ops) renderOp(out, op, ctx)
  return Object.freeze(out)
}

function renderOp(out: string[], op: Op, ctx: RenderContext): void {
  switch (op.kind) {
    case 'enable-rls':
      out.push(`ALTER TABLE ${quoteIdent(op.table)} ENABLE ROW LEVEL SECURITY;`)
      return
    case 'disable-rls':
      out.push(`ALTER TABLE ${quoteIdent(op.table)} DISABLE ROW LEVEL SECURITY;`)
      return
    case 'force-rls':
      out.push(`ALTER TABLE ${quoteIdent(op.table)} FORCE ROW LEVEL SECURITY;`)
      return
    case 'unforce-rls':
      out.push(`ALTER TABLE ${quoteIdent(op.table)} NO FORCE ROW LEVEL SECURITY;`)
      return
    case 'create-policy':
      renderCreatePolicy(out, op.policy, ctx)
      return
    case 'drop-policy':
      out.push(`DROP POLICY IF EXISTS ${quoteIdent(op.name)} ON ${quoteIdent(op.table)};`)
      return
    case 'grant-column':
      out.push(
        `GRANT ${verbDdl(op.verb)} (${quoteIdent(op.column)}) ON ${quoteIdent(op.table)} TO ${quoteIdent(op.role)};`
      )
      return
    case 'revoke-column':
      out.push(
        `REVOKE ${verbDdl(op.verb)} (${quoteIdent(op.column)}) ON ${quoteIdent(op.table)} FROM ${quoteIdent(op.role)};`
      )
      return
    case 'create-role':
      out.push(renderCreateRole(op.name, op.bypassesRls, op.nologin))
      return
    case 'drop-role':
      out.push(renderDropRole(op.name))
      return
    case 'grant-role-membership':
      out.push(renderGrantMembership(op.parent, op.child))
      return
    case 'revoke-role-membership':
      out.push(renderRevokeMembership(op.parent, op.child))
      return
  }
}

function renderCreatePolicy(out: string[], policy: PolicyOpRecord, ctx: RenderContext): void {
  const table = quoteIdent(policy.table)
  const name = quoteIdent(policy.name)
  // Drop precedes create so the statement is idempotent on re-runs and
  // tolerant of policy renames or attribute drift.
  out.push(`DROP POLICY IF EXISTS ${name} ON ${table};`)

  for (const todo of policy.todos) {
    out.push(`-- TODO [${policy.table}]: ${todo.replace(/\r?\n/g, ' ')}`)
  }

  const exprCtx: ExprCompileCtx = {
    table: policy.table,
    qualifyColumns: policy.discriminator !== undefined,
    claims: ctx.claims,
    ...(ctx.resourceGrants !== undefined && { resourceGrants: ctx.resourceGrants }),
    ...(ctx.compileHasAppRole !== undefined && { compileHasAppRole: ctx.compileHasAppRole }),
    ...(ctx.compileHasGrant !== undefined && { compileHasGrant: ctx.compileHasGrant }),
    ...(ctx.compileHasResourcePermission !== undefined && {
      compileHasResourcePermission: ctx.compileHasResourcePermission,
    }),
    ...(ctx.compileIsOwner !== undefined && { compileIsOwner: ctx.compileIsOwner }),
  }

  const usingSql = policy.using === undefined ? undefined : compileExpr(policy.using, exprCtx)
  const checkSql = policy.check === undefined ? undefined : compileExpr(policy.check, exprCtx)

  const stmt =
    `CREATE POLICY ${name} ON ${table} FOR ${verbDdl(policy.verb)} TO ${quoteIdent(policy.dbRole)}` +
    (usingSql !== undefined ? ` USING (${usingSql})` : '') +
    (checkSql !== undefined ? ` WITH CHECK (${checkSql})` : '') +
    ';'
  out.push(stmt)
}

function verbDdl(verb: Verb | ColumnVerb): string {
  return verb.toUpperCase()
}

function renderCreateRole(name: string, bypassesRls: boolean, nologin: boolean): string {
  const attrs = ['INHERIT']
  if (bypassesRls) attrs.push('BYPASSRLS')
  if (nologin) attrs.push('NOLOGIN')
  return [
    'DO $$',
    'BEGIN',
    `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteString(name)}) THEN`,
    `    CREATE ROLE ${quoteIdent(name)} ${attrs.join(' ')};`,
    '  END IF;',
    'END',
    '$$;',
  ].join('\n')
}

function renderDropRole(name: string): string {
  // DROP ROLE IF EXISTS leaves us tolerant of partial-failure replays; the
  // wrapper checks pg_roles so we don't surface a NOTICE on every clean run.
  return [
    'DO $$',
    'BEGIN',
    `  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteString(name)}) THEN`,
    `    DROP ROLE ${quoteIdent(name)};`,
    '  END IF;',
    'END',
    '$$;',
  ].join('\n')
}

function renderGrantMembership(parent: string, child: string): string {
  return [
    'DO $$',
    'BEGIN',
    '  IF NOT EXISTS (',
    '    SELECT 1 FROM pg_auth_members am',
    '    JOIN pg_roles parent ON parent.oid = am.roleid',
    '    JOIN pg_roles child ON child.oid = am.member',
    `    WHERE parent.rolname = ${quoteString(parent)} AND child.rolname = ${quoteString(child)}`,
    '  ) THEN',
    `    GRANT ${quoteIdent(parent)} TO ${quoteIdent(child)};`,
    '  END IF;',
    'END',
    '$$;',
  ].join('\n')
}

function renderRevokeMembership(parent: string, child: string): string {
  return [
    'DO $$',
    'BEGIN',
    '  IF EXISTS (',
    '    SELECT 1 FROM pg_auth_members am',
    '    JOIN pg_roles parent ON parent.oid = am.roleid',
    '    JOIN pg_roles child ON child.oid = am.member',
    `    WHERE parent.rolname = ${quoteString(parent)} AND child.rolname = ${quoteString(child)}`,
    '  ) THEN',
    `    REVOKE ${quoteIdent(parent)} FROM ${quoteIdent(child)};`,
    '  END IF;',
    'END',
    '$$;',
  ].join('\n')
}
