/**
 * Postgres identifier quoting and table-name resolution.
 *
 * Intentionally duplicated from `@flowchestra/prisma-guarddog-emitter-postgres-rls`
 * rather than cross-imported. The two emitters share these utilities but
 * not enough else to warrant a third "postgres-shared" package — ~30 LOC
 * of duplication is the right answer until a third dialect emitter joins.
 */

export function quoteIdent(name: string): string {
  if (name.length === 0) {
    throw new Error('[prisma-guarddog/emitter-postgres-column-privileges] quoteIdent: identifier must be non-empty.')
  }
  if (/^[a-z_][a-z0-9_]*$/.test(name)) return name
  return `"${name.replace(/"/g, '""')}"`
}

export function defaultTableResolver(modelName: string): string {
  return modelName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
}

export function resolveTableName(
  modelName: string,
  override: string | undefined,
  resolver: ((modelName: string) => string) | undefined
): string {
  if (override !== undefined) return override
  return (resolver ?? defaultTableResolver)(modelName)
}
