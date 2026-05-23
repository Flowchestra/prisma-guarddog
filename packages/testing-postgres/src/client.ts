/**
 * Minimal pg-compatible client surface used by the harness. Mirrors
 * `pg.Client.query` / `pg.PoolClient.query` so consumers can pass either
 * without an adapter, and tests can pass a fake.
 *
 * Kept separate from the rest of the harness because the same surface
 * shows up in importer-postgres; promoting it to a tiny shared shape
 * lets both packages avoid taking a hard `pg` dependency.
 */

export interface PgSessionClient {
  query<R extends object = Record<string, unknown>>(
    text: string,
    params?: ReadonlyArray<unknown>
  ): Promise<{ readonly rows: R[] }>
}
