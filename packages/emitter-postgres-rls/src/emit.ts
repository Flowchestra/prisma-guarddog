/**
 * Compile guarddog AST nodes to idempotent Postgres DDL.
 *
 * Per ADR-0008, all emitted DDL is safe to re-run:
 *   - `ENABLE / FORCE ROW LEVEL SECURITY` — natively idempotent.
 *   - `CREATE POLICY` — emitted as `DROP POLICY IF EXISTS ... ; CREATE POLICY ...`.
 *
 * Pure transformation: AST in, SQL strings out. No I/O, no DB connection.
 */

import type {
  ClaimsDefinition,
  Expr,
  PolicyAst,
  PolymorphicAst,
  PolymorphicTargetAst,
  PolymorphicTargetPolicyAst,
  ResourceGrantsDefinition,
} from '@flowchestra/prisma-guarddog-core'

import {
  compileExpr,
  type ExprCompileCtx,
  type HasAppRoleCompiler,
  type HasGrantCompiler,
  type HasResourcePermissionCompiler,
  type IsOwnerCompiler,
} from './compile-expr.js'
import { defaultTableResolver, policyName, quoteIdent, quoteString } from './identifiers.js'

export interface EmitContext {
  readonly claims: ClaimsDefinition
  /**
   * The configured resource-grants layer. Drives the claim path used by
   * `hasGrant` compilation (default 'grants'). Required only when the
   * compiled policies reference `p.hasGrant(...)`.
   */
  readonly resourceGrants?: ResourceGrantsDefinition
  /**
   * Target schema for guarddog-managed functions (ADR-0026). Required only
   * when compiled policies reference `p.fn(...)`. Set from
   * `defineFunctions({ schema })`.
   */
  readonly functionSchema?: string
  /**
   * Override the Prisma model -> table name mapping. Falls back to
   * `defaultTableResolver` (CamelCase -> snake_case, singular, lowercase).
   * Consumers using Prisma `@@map` directives should plug in a resolver
   * that consults the DMMF.
   */
  readonly resolveTable?: (modelName: string) => string
  readonly compileHasAppRole?: HasAppRoleCompiler
  readonly compileHasGrant?: HasGrantCompiler
  readonly compileHasResourcePermission?: HasResourcePermissionCompiler
  readonly compileIsOwner?: IsOwnerCompiler
  /**
   * When true, every column reference in compiled predicates is qualified
   * with the table name. Defaults to false for regular policies and is
   * forced true for polymorphic-target emission (where the discriminator
   * column would otherwise be ambiguous).
   */
  readonly qualifyColumns?: boolean
}

/**
 * Compile a single `PolicyAst` to a flat array of SQL statements (each
 * trailing-semicolon-included). The ordering is:
 *
 *   1. ALTER TABLE ... ENABLE ROW LEVEL SECURITY
 *   2. ALTER TABLE ... FORCE ROW LEVEL SECURITY
 *   3. For each declared verb, in select/insert/update/delete order:
 *        DROP POLICY IF EXISTS "..." ON "...";
 *        CREATE POLICY "..." ON "..." FOR <VERB> TO <role> ... ;
 *
 * The orchestrator (`Guarddog.emit()`, landing later) is responsible for
 * deduping ENABLE/FORCE statements across policies that share a table.
 */
export function emitPolicy(policy: PolicyAst, ctx: EmitContext): readonly string[] {
  const table = resolveTableName(policy.model, policy.table, ctx)
  const out: string[] = []
  appendTableSetup(out, table)
  appendTodos(out, table, policy.todos)

  const exprCtx: ExprCompileCtx = makeExprCtx(table, ctx, ctx.qualifyColumns ?? false)
  const dbRoleSql = quoteIdent(policy.dbRole)
  const restrictive = policy.restrictive === true

  // `spec.name ?? policyName(...)` honors user-declared overrides (ADR-0031).
  // The same name flows into both the DROP and CREATE inside `emitCreatePolicy`,
  // so a typed replacement under a legacy name swaps in place atomically.
  //
  // ADR-0032: restrictive policies declare a single `FOR ALL` spec; the
  // `<table>_isolation` auto-name applies when `.isolation()` set the flag.
  if (policy.all !== undefined) {
    // ADR-0033: slot drives the auto-name when set to a non-default value.
    const slotForName = policy.slot !== undefined && policy.slot !== 'default' ? policy.slot : undefined
    const name =
      policy.all.name ??
      (policy.isolation === true
        ? slotForName !== undefined
          ? `${table}_${slotForName}`
          : `${table}_isolation`
        : slotForName !== undefined
          ? `${table}_${policy.dbRole}_${slotForName}`
          : policyName({ table, dbRole: policy.dbRole, verb: 'all' }))
    out.push(
      ...emitCreatePolicy(name, table, dbRoleSql, 'ALL', policy.all.using, policy.all.check, exprCtx, { restrictive })
    )
  }
  // ADR-0034: per-verb specs honor slot when present (`<table>_<role>_<slot>_<verb>`).
  const perVerbSlot = policy.slot !== undefined && policy.slot !== 'default' ? policy.slot : undefined
  const autoVerbName = (verb: 'select' | 'insert' | 'update' | 'delete'): string =>
    perVerbSlot !== undefined
      ? `${table}_${policy.dbRole}_${perVerbSlot}_${verb}`
      : policyName({ table, dbRole: policy.dbRole, verb })
  if (policy.select !== undefined) {
    const name = policy.select.name ?? autoVerbName('select')
    out.push(
      ...emitCreatePolicy(name, table, dbRoleSql, 'SELECT', policy.select.using, undefined, exprCtx, { restrictive })
    )
  }
  if (policy.insert !== undefined) {
    const name = policy.insert.name ?? autoVerbName('insert')
    out.push(
      ...emitCreatePolicy(name, table, dbRoleSql, 'INSERT', undefined, policy.insert.check, exprCtx, { restrictive })
    )
  }
  if (policy.update !== undefined) {
    const name = policy.update.name ?? autoVerbName('update')
    out.push(
      ...emitCreatePolicy(name, table, dbRoleSql, 'UPDATE', policy.update.using, policy.update.check, exprCtx, {
        restrictive,
      })
    )
  }
  if (policy.delete !== undefined) {
    const name = policy.delete.name ?? autoVerbName('delete')
    out.push(
      ...emitCreatePolicy(name, table, dbRoleSql, 'DELETE', policy.delete.using, undefined, exprCtx, { restrictive })
    )
  }

  return Object.freeze(out)
}

/**
 * Compile a polymorphic declaration to SQL. Each target produces its own
 * set of `CREATE POLICY` statements with the discriminator equality
 * prepended automatically. ENABLE/FORCE RLS happen once per polymorphic
 * (since all targets share the same table).
 *
 * Column references in polymorphic-target policies are qualified by default
 * — the discriminator column itself would otherwise be ambiguous between
 * a literal column reference and a value in claim payload.
 */
export function emitPolymorphic(poly: PolymorphicAst, ctx: EmitContext): readonly string[] {
  const table = resolveTableName(poly.modelName, poly.table, ctx)
  const out: string[] = []
  appendTableSetup(out, table)

  const exprCtx: ExprCompileCtx = makeExprCtx(table, ctx, true)

  for (const target of poly.targets) {
    const discriminatorEq = formatDiscriminatorEquality(table, poly.discriminator, target.discriminatorValue)
    for (const targetPolicy of target.policies) {
      appendTodos(out, table, targetPolicy.todos)
      appendTargetPolicies(out, table, target, targetPolicy, discriminatorEq, exprCtx)
    }
  }

  return Object.freeze(out)
}

function appendTargetPolicies(
  out: string[],
  table: string,
  target: PolymorphicTargetAst,
  targetPolicy: PolymorphicTargetPolicyAst,
  discriminatorEq: string,
  exprCtx: ExprCompileCtx
): void {
  const dbRoleSql = quoteIdent(targetPolicy.dbRole)
  const baseParts = {
    table,
    dbRole: targetPolicy.dbRole,
    discriminatorValue: target.discriminatorValue,
  }

  if (targetPolicy.select !== undefined) {
    const name = targetPolicy.select.name ?? policyName({ ...baseParts, verb: 'select' })
    out.push(
      ...emitCreatePolicy(
        name,
        table,
        dbRoleSql,
        'SELECT',
        joinWithDiscriminator(discriminatorEq, targetPolicy.select.using, exprCtx),
        undefined,
        exprCtx,
        { alreadyCompiledUsing: true }
      )
    )
  }
  if (targetPolicy.insert !== undefined) {
    const name = targetPolicy.insert.name ?? policyName({ ...baseParts, verb: 'insert' })
    out.push(
      ...emitCreatePolicy(
        name,
        table,
        dbRoleSql,
        'INSERT',
        undefined,
        joinWithDiscriminator(discriminatorEq, targetPolicy.insert.check, exprCtx),
        exprCtx,
        { alreadyCompiledCheck: true }
      )
    )
  }
  if (targetPolicy.update !== undefined) {
    const name = targetPolicy.update.name ?? policyName({ ...baseParts, verb: 'update' })
    out.push(
      ...emitCreatePolicy(
        name,
        table,
        dbRoleSql,
        'UPDATE',
        joinWithDiscriminator(discriminatorEq, targetPolicy.update.using, exprCtx),
        joinWithDiscriminator(discriminatorEq, targetPolicy.update.check, exprCtx),
        exprCtx,
        { alreadyCompiledUsing: true, alreadyCompiledCheck: true }
      )
    )
  }
  if (targetPolicy.delete !== undefined) {
    const name = targetPolicy.delete.name ?? policyName({ ...baseParts, verb: 'delete' })
    out.push(
      ...emitCreatePolicy(
        name,
        table,
        dbRoleSql,
        'DELETE',
        joinWithDiscriminator(discriminatorEq, targetPolicy.delete.using, exprCtx),
        undefined,
        exprCtx,
        { alreadyCompiledUsing: true }
      )
    )
  }
}

function formatDiscriminatorEquality(table: string, discriminatorColumn: string, discriminatorValue: string): string {
  return `${quoteIdent(table)}.${quoteIdent(discriminatorColumn)} = ${quoteString(discriminatorValue)}`
}

function joinWithDiscriminator(discriminatorEq: string, expr: Expr, ctx: ExprCompileCtx): string {
  const compiled = compileExpr(expr, ctx)
  return `(${discriminatorEq}) AND ${compiled}`
}

function appendTableSetup(out: string[], table: string): void {
  out.push(`ALTER TABLE ${quoteIdent(table)} ENABLE ROW LEVEL SECURITY;`)
  out.push(`ALTER TABLE ${quoteIdent(table)} FORCE ROW LEVEL SECURITY;`)
}

function appendTodos(out: string[], table: string, todos: ReadonlyArray<string>): void {
  for (const todo of todos) {
    out.push(`-- TODO [${table}]: ${todo.replace(/\r?\n/g, ' ')}`)
  }
}

interface EmitCreateOpts {
  readonly alreadyCompiledUsing?: boolean
  readonly alreadyCompiledCheck?: boolean
  /** ADR-0032: emit `AS RESTRICTIVE`. Default false / undefined = permissive (implicit). */
  readonly restrictive?: boolean
}

function emitCreatePolicy(
  name: string,
  table: string,
  dbRoleSql: string,
  verb: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL',
  using: Expr | string | undefined,
  check: Expr | string | undefined,
  ctx: ExprCompileCtx,
  opts: EmitCreateOpts = {}
): string[] {
  const quotedName = quoteIdent(name)
  const quotedTable = quoteIdent(table)
  const usingSql = using === undefined ? undefined : typeof using === 'string' ? using : compileExpr(using, ctx)
  const checkSql = check === undefined ? undefined : typeof check === 'string' ? check : compileExpr(check, ctx)

  const asClause = opts.restrictive === true ? ' AS RESTRICTIVE' : ''
  const drop = `DROP POLICY IF EXISTS ${quotedName} ON ${quotedTable};`
  const create =
    `CREATE POLICY ${quotedName} ON ${quotedTable}${asClause} FOR ${verb} TO ${dbRoleSql}` +
    (usingSql !== undefined ? ` USING (${usingSql})` : '') +
    (checkSql !== undefined ? ` WITH CHECK (${checkSql})` : '') +
    ';'
  return [drop, create]
}

function makeExprCtx(table: string, ctx: EmitContext, qualifyColumns: boolean): ExprCompileCtx {
  return {
    table,
    qualifyColumns,
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
}

function resolveTableName(modelName: string, override: string | undefined, ctx: EmitContext): string {
  if (override !== undefined) return override
  const resolver = ctx.resolveTable ?? defaultTableResolver
  return resolver(modelName)
}
