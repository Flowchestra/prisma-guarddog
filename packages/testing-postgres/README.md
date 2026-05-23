# @prisma-guarddog/testing-postgres

Real-Postgres verification harness for RLS policies.

Per [ADR-0013](../../docs/adr/0013-real-postgres-required-for-tests.md) there is **no** `pg-mem` / `pglite` / in-memory option, and the package will not accept a PR adding one. Tests that pass against an in-memory shim while the production query fails on real Postgres are worse than no tests — they ship false confidence.

## What lives here

- **`withScenario(client, { role, claims }, fn)`** — opens a transaction, installs the test identity via `SELECT set_config('role', …)` and `SELECT set_config('request.jwt.claims', …)`, runs `fn`, then `ROLLBACK`. The body sees the same session so every subsequent `client.query(...)` inherits the role and claims.
- **`assertAllowed(promise)`** — passes if `promise` resolves; returns its value. Failures rethrow with an "expected to be allowed" prefix.
- **`assertDenied(promise, opts?)`** — passes if `promise` rejects with a Postgres RLS / permission-denied / WITH-CHECK-violation error. Override `pattern` to narrow the match.
- **`assertVisibleRows({ rows }, n)`** — passes iff exactly `n` rows.
- **`assertHiddenColumns(row, columns)`** — passes iff every named column is missing or null. Use to verify column-level REVOKE.
- **`AssertionError`** — distinct error type so test runners format harness failures cleanly.

## Install

```sh
pnpm add -D @prisma-guarddog/testing-postgres pg
```

## 30-second usage

```ts
import { Client } from 'pg'
import { assertAllowed, assertDenied, withScenario } from '@prisma-guarddog/testing-postgres'

const client = new Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

await withScenario(
  client,
  { role: 'app_user', claims: { sub: 'u1', tenantId: '00000000-0000-0000-0000-00000000000a' } },
  async (db) => {
    await assertAllowed(db.query('SELECT id FROM workspace', []))
    await assertDenied(
      db.query(
        `INSERT INTO workspace (id, "tenantId", name) VALUES ($1, $2, 'sneaky')`,
        ['…', '00000000-0000-0000-0000-00000000000b'] // other tenant
      )
    )
  }
)
```

## Client surface

`PgSessionClient` is the minimal shape the harness needs:

```ts
interface PgSessionClient {
  query<R extends object>(text: string, params?: ReadonlyArray<unknown>): Promise<{ rows: R[] }>
}
```

`pg.Client`, `pg.PoolClient`, and any custom adapter that matches the shape work without modification.

## Where to read next

- [`docs/adr/0013-real-postgres-required-for-tests.md`](../../docs/adr/0013-real-postgres-required-for-tests.md) — the real-PG-only contract
- [`examples/flowchestra/src/e2e-postgres.test.ts`](../../examples/flowchestra/src/e2e-postgres.test.ts) — a full E2E suite using this harness
