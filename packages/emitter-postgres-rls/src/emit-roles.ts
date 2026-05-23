/**
 * Emit Postgres role DDL from a `DbRolesDefinition`.
 *
 * Self-contained per the principle: if guarddog declares the roles, guarddog
 * emits them. Consumers never have to `psql` in to bootstrap `app_user` /
 * `app_system` / etc.
 *
 * Output ordering:
 *   1. CREATE ROLE for every declared role (idempotent: wrapped in a DO block
 *      that checks `pg_roles` first). Forward references in `inherits` are
 *      fine because membership grants happen in a second pass.
 *   2. GRANT <parent> TO <child> for every entry in the inheritance graph
 *      (also idempotent — wrapped in a DO block that checks `pg_auth_members`).
 *
 * Role attributes honored:
 *   - `bypassesRls: true`  -> `BYPASSRLS`
 *   - `nologin: true`      -> `NOLOGIN`
 *
 * Postgres role attributes default to NOINHERIT in modern versions; guarddog
 * explicitly emits `INHERIT` so the membership grants (step 2) actually
 * cascade privileges. This matches the semantics implied by
 * `defineDbRoles({ app_system: { inherits: ['app_user'] } })`.
 */

import type { DbRolesDefinition } from '@prisma-guarddog/core'

import { quoteIdent, quoteString } from './identifiers.js'

/**
 * Compile every declared dbRole to idempotent Postgres DDL. Returns a flat,
 * deterministic array of statements ready to drop into a migration file.
 */
export function emitRoles(dbRoles: DbRolesDefinition): readonly string[] {
  const out: string[] = []
  const entries = Object.entries(dbRoles.roles)

  for (const [name, spec] of entries) {
    out.push(makeCreateRoleStatement(name, spec))
  }

  for (const [name, spec] of entries) {
    for (const parent of spec.inherits) {
      out.push(makeGrantRoleStatement(parent, name))
    }
  }

  return Object.freeze(out)
}

interface MinimalRoleSpec {
  readonly bypassesRls?: boolean
  readonly nologin?: boolean
}

function makeCreateRoleStatement(name: string, spec: MinimalRoleSpec): string {
  const attrs: string[] = ['INHERIT']
  if (spec.bypassesRls === true) attrs.push('BYPASSRLS')
  if (spec.nologin === true) attrs.push('NOLOGIN')
  const attrSql = attrs.join(' ')
  return [
    'DO $$',
    'BEGIN',
    `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteString(name)}) THEN`,
    `    CREATE ROLE ${quoteIdent(name)} ${attrSql};`,
    '  END IF;',
    'END',
    '$$;',
  ].join('\n')
}

function makeGrantRoleStatement(parent: string, child: string): string {
  // `pg_auth_members` records role-in-role grants. We check by role name (via
  // joins on pg_roles) so the lookup is independent of OID. `GRANT role TO role`
  // emits a NOTICE on duplicate in modern Postgres but is wrapped here for
  // safety across versions and for clean re-runs.
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
