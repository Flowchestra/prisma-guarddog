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
  FunctionOpRecord,
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

/**
 * The four predicate-compiler overrides, factored out of `RenderContext` so
 * the CLI config (`guarddog.config.ts` → `renderOverrides`) and the migrate
 * pipeline can pass them around as a unit. When a consumer's authorization
 * model doesn't fit the built-in templates (e.g. rank-based or
 * group-disjunctive grants), they supply a `compileHasGrant` here and it
 * wins over the source-based dispatch. See ADR-0024.
 */
export interface RenderOverrides {
  readonly compileHasAppRole?: HasAppRoleCompiler
  readonly compileHasGrant?: HasGrantCompiler
  readonly compileHasResourcePermission?: HasResourcePermissionCompiler
  readonly compileIsOwner?: IsOwnerCompiler
}

export interface RenderContext extends RenderOverrides {
  readonly claims: ClaimsDefinition
  readonly resourceGrants?: ResourceGrantsDefinition
  /**
   * Target schema for guarddog-managed functions (ADR-0026). Threaded into
   * the predicate compile context so `p.fn(name, ...)` renders as
   * `<schema>.<name>(...)`. Undefined when no functions are declared.
   */
  readonly functionSchema?: string
}

/**
 * Render a sequence of ops to SQL. Ops are processed in input order; the
 * caller (diff or compile) is responsible for producing a safe ordering.
 */
export function renderOps(ops: ReadonlyArray<Op>, ctx: RenderContext): readonly string[] {
  const out: string[] = []
  // Tracks `${schema}::${role}` pairs for which a `GRANT USAGE ON SCHEMA` has
  // already been emitted in this render, so a role with EXECUTE on several
  // functions in the same schema gets one USAGE grant, not one per function.
  const seenSchemaUsage = new Set<string>()
  for (const op of ops) renderOp(out, op, ctx, seenSchemaUsage)
  return Object.freeze(out)
}

function renderOp(out: string[], op: Op, ctx: RenderContext, seenSchemaUsage: Set<string>): void {
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
    case 'create-schema':
      out.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(op.schema)};`)
      return
    case 'create-function':
      out.push(renderCreateFunction(op.fn))
      return
    case 'drop-function':
      out.push(`DROP FUNCTION IF EXISTS ${functionRef(op.schema, op.name, op.argTypes)};`)
      return
    case 'grant-execute': {
      // EXECUTE on a function is useless without USAGE on its schema; emit the
      // USAGE grant once per (schema, role). GRANT USAGE is idempotent, so
      // re-running the migration is safe.
      const usageKey = `${op.schema}::${op.role}`
      if (!seenSchemaUsage.has(usageKey)) {
        seenSchemaUsage.add(usageKey)
        out.push(`GRANT USAGE ON SCHEMA ${quoteIdent(op.schema)} TO ${quoteIdent(op.role)};`)
      }
      out.push(`GRANT EXECUTE ON FUNCTION ${functionRef(op.schema, op.name, op.argTypes)} TO ${quoteIdent(op.role)};`)
      return
    }
    case 'revoke-execute':
      out.push(
        `REVOKE EXECUTE ON FUNCTION ${functionRef(op.schema, op.name, op.argTypes)} FROM ${quoteIdent(op.role)};`
      )
      return
  }
}

/**
 * `"schema"."name"(type1, type2)` — the signature form Postgres uses to
 * identify a function for DROP / GRANT / REVOKE. Argument types are inserted
 * verbatim (they're trusted, declared in `defineFunctions`).
 */
function functionRef(schema: string, name: string, argTypes: ReadonlyArray<string>): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}(${argTypes.join(', ')})`
}

/**
 * Render `CREATE OR REPLACE FUNCTION` DDL from a {@link FunctionOpRecord}.
 * EXECUTE grants are emitted separately (as grant-execute ops) so a grant
 * change on an otherwise-unchanged function diffs cleanly. Idempotent:
 * CREATE OR REPLACE is natively re-runnable; a signature change is handled by
 * a preceding drop-function op.
 */
function renderCreateFunction(fn: FunctionOpRecord): string {
  const args = fn.args
    .map((a) => `${quoteIdent(a.name)} ${a.type}${a.default !== undefined ? ` DEFAULT ${a.default}` : ''}`)
    .join(', ')
  const header = `CREATE OR REPLACE FUNCTION ${quoteIdent(fn.schema)}.${quoteIdent(fn.name)}(${args})`

  const clauses = [
    `RETURNS ${fn.returns}`,
    `LANGUAGE ${fn.language}`,
    fn.volatility.toUpperCase(),
    `PARALLEL ${fn.parallel.toUpperCase()}`,
    `SECURITY ${fn.security.toUpperCase()}`,
  ]
  if (fn.searchPath.length > 0) {
    clauses.push(`SET search_path TO ${fn.searchPath.map((p) => quoteIdent(p)).join(', ')}`)
  }

  const tag = dollarQuoteTag(fn.body)
  return `${header}\n${clauses.join('\n')}\nAS ${tag}\n${fn.body}\n${tag};`
}

/**
 * Pick a dollar-quote tag that does not occur in the body so the body is
 * emitted verbatim with no escaping. Starts at `$guarddog$` and appends an
 * incrementing suffix until it's collision-free.
 */
function dollarQuoteTag(body: string): string {
  let tag = '$guarddog$'
  let n = 0
  while (body.includes(tag)) {
    n += 1
    tag = `$guarddog${n}$`
  }
  return tag
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
    ...(ctx.functionSchema !== undefined && { functionSchema: ctx.functionSchema }),
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
