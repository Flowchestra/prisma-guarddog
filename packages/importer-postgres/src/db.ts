/**
 * Read live Postgres state for the scaffold importer.
 *
 * Two queries: `pg_policies` for RLS policies (existing CREATE POLICY
 * statements) and `information_schema.column_privileges` for per-column
 * GRANT records. We accept any object that has a `.query(text, params)`
 * method returning `{ rows }`, so consumers can pass `pg.Client`,
 * `pg.Pool`, a `Pool.connect()` result, or a custom adapter without us
 * taking a hard dependency on the `pg` package.
 *
 * No filtering / normalization beyond shape: this is the evidence layer.
 * The codegen layer (in `./codegen.ts`) decides how to render evidence
 * into `rawSql()` calls and `.todo()` markers — see ADR-0012.
 */

/** Minimal pg-compatible client surface (matches `pg.Client.query` shape). */
export interface PgQueryClient {
  query<R extends object = Record<string, unknown>>(
    text: string,
    params?: ReadonlyArray<unknown>
  ): Promise<{ readonly rows: R[] }>
}

export interface ImportedPolicyRow {
  readonly schema: string
  readonly table: string
  readonly policyName: string
  /** As returned by pg_policies.cmd — uppercased verb word or 'ALL'. */
  readonly command: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL'
  /** As returned by pg_policies.roles — Postgres role names. */
  readonly roles: ReadonlyArray<string>
  /** pg_policies.qual; null when the policy has no USING clause. */
  readonly usingExpression: string | null
  /** pg_policies.with_check; null when the policy has no WITH CHECK clause. */
  readonly withCheckExpression: string | null
  readonly permissive: boolean
}

export interface ImportedColumnPrivilege {
  readonly schema: string
  readonly table: string
  readonly column: string
  readonly grantee: string
  readonly privilege: 'SELECT' | 'INSERT' | 'UPDATE'
}

export interface ReadPoliciesOptions {
  /** Postgres schema name to filter on. Defaults to `public`. */
  readonly schema?: string
}

/**
 * Read `pg_policies` for the configured schema. Rows arrive sorted by
 * (table, policy name) so importer output is deterministic across runs.
 */
export async function readPgPolicies(
  client: PgQueryClient,
  opts: ReadPoliciesOptions = {}
): Promise<ReadonlyArray<ImportedPolicyRow>> {
  const schema = opts.schema ?? 'public'
  const { rows } = await client.query<RawPolicyRow>(
    `SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
     FROM pg_policies
     WHERE schemaname = $1
     ORDER BY schemaname, tablename, policyname`,
    [schema]
  )
  return Object.freeze(rows.map(normalizePolicyRow))
}

/**
 * Read column-level GRANTs from `information_schema.column_privileges`.
 * Filters to SELECT/INSERT/UPDATE since DELETE / REFERENCES / TRIGGER
 * aren't representable as `columnPrivileges()` declarations (verb-level
 * GRANTs handle the rest).
 */
export async function readColumnPrivileges(
  client: PgQueryClient,
  opts: ReadPoliciesOptions = {}
): Promise<ReadonlyArray<ImportedColumnPrivilege>> {
  const schema = opts.schema ?? 'public'
  const { rows } = await client.query<RawColumnPrivilegeRow>(
    `SELECT table_schema, table_name, column_name, grantee, privilege_type
     FROM information_schema.column_privileges
     WHERE table_schema = $1
       AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE')
     ORDER BY table_schema, table_name, column_name, grantee, privilege_type`,
    [schema]
  )
  return Object.freeze(rows.map(normalizeColumnPrivilegeRow))
}

interface RawPolicyRow {
  readonly schemaname: string
  readonly tablename: string
  readonly policyname: string
  readonly permissive: 'PERMISSIVE' | 'RESTRICTIVE' | boolean
  /**
   * As returned by `pg_policies.roles` (column type `name[]`). Node-postgres
   * parses most array columns into JS arrays automatically, but the `name[]`
   * type often arrives as a raw Postgres array literal (`{role1,role2}`).
   * `normalizePolicyRow` handles both shapes via `parseRolesField`.
   */
  readonly roles: ReadonlyArray<string> | string
  readonly cmd: string
  readonly qual: string | null
  readonly with_check: string | null
}

interface RawColumnPrivilegeRow {
  readonly table_schema: string
  readonly table_name: string
  readonly column_name: string
  readonly grantee: string
  readonly privilege_type: string
}

function normalizePolicyRow(row: RawPolicyRow): ImportedPolicyRow {
  const cmd = row.cmd.toUpperCase()
  return Object.freeze({
    schema: row.schemaname,
    table: row.tablename,
    policyName: row.policyname,
    command: isPolicyCommand(cmd) ? cmd : 'ALL',
    roles: Object.freeze(parseRolesField(row.roles)),
    usingExpression: row.qual,
    withCheckExpression: row.with_check,
    permissive: row.permissive === 'PERMISSIVE' || row.permissive === true,
  })
}

/**
 * Coerce `pg_policies.roles` into a `string[]`. Node-postgres returns this
 * column either as a JS array (when the `name[]` type parser is wired) or
 * as a raw Postgres array literal `{role1,role2,"quoted role"}`. We accept
 * both; the literal form is parsed minimally — comma-split with unwrapping
 * of double-quoted entries. Role names containing literal commas or
 * backslashes inside quotes are not supported (Postgres role names are
 * identifiers, which excludes those characters in practice).
 */
function parseRolesField(value: ReadonlyArray<string> | string): string[] {
  if (Array.isArray(value)) return [...value]
  if (typeof value !== 'string') return []
  const trimmed = value.trim()
  if (trimmed.length === 0) return []
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    // Single bare role name without array wrapping — treat as one entry.
    return [trimmed]
  }
  const inner = trimmed.slice(1, -1)
  if (inner.length === 0) return []
  return inner.split(',').map((part) => {
    const t = part.trim()
    if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1)
    return t
  })
}

function normalizeColumnPrivilegeRow(row: RawColumnPrivilegeRow): ImportedColumnPrivilege {
  const priv = row.privilege_type.toUpperCase()
  if (priv !== 'SELECT' && priv !== 'INSERT' && priv !== 'UPDATE') {
    throw new Error(
      `[prisma-guarddog/importer-postgres] unexpected privilege type "${row.privilege_type}" — ` +
        'the readColumnPrivileges query filters on SELECT/INSERT/UPDATE.'
    )
  }
  return Object.freeze({
    schema: row.table_schema,
    table: row.table_name,
    column: row.column_name,
    grantee: row.grantee,
    privilege: priv,
  })
}

function isPolicyCommand(s: string): s is 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL' {
  return s === 'SELECT' || s === 'INSERT' || s === 'UPDATE' || s === 'DELETE' || s === 'ALL'
}
