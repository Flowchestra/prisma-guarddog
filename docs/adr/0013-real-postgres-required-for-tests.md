# 0013 — Real Postgres required for tests

**Status:** Accepted
**Date:** 2026-05-23

## Context

The testing extension verifies that policies behave as intended — that `app_user` with a particular claim set sees the rows it should see, can write the rows it should be allowed to write, and cannot write the rows it should be denied. Several testing strategies exist:

- **In-memory shim** (`pg-mem`, `pglite`): runs a Postgres-compatible engine inside Node. Fast, no external DB needed.
- **Real Postgres**: requires a Postgres URL (Docker, ephemeral cloud, etc.). Slower; matches production exactly.
- **Pure unit tests of the emitter**: verify the SQL emitted matches expectations, without applying it. No execution; no semantic verification.

The first option fails because Postgres RLS depends on features that no in-memory shim implements completely:

- Role inheritance and `SET ROLE`
- `current_setting('request.jwt.claims', true)` semantics
- Column-level `GRANT`/`REVOKE`
- `FORCE ROW LEVEL SECURITY` interaction with table ownership
- Function privileges on `app.*` helpers

Tests that pass against `pg-mem` while the production query fails on real Postgres are worse than no tests at all — they ship false confidence.

## Decision

The testing extension (`@prisma-guarddog/testing-postgres`) requires a real Postgres connection. There is no `pg-mem` / `pglite` / in-memory option, and the package will not accept a PR adding one.

Each test runs inside a transaction (`BEGIN ... ROLLBACK`) for isolation, with `SET LOCAL ROLE` and `SET LOCAL request.jwt.claims = '...'` to install the test's identity:

```ts
import { withDbRole, withClaims, assertAllowed, assertDenied } from '@prisma-guarddog/testing-postgres';

test('app_user cannot read workbenches in other tenants', () =>
  withDbRole('app_user', withClaims({ tenantId: 'A', workspaceId: 'X' }, async (db) => {
    await assertDenied(db.workbench.findMany({ where: { tenantId: 'B' } }));
  }))
);
```

The unit-test layer (emitter-output verification) is **also** maintained, but it's complementary, not a substitute. Emitter unit tests catch regression in DDL formatting; the real-PG harness catches regression in semantics.

## Consequences

**Positive:**

- Tests verify the same enforcement path that runs in production.
- No false-positive coverage from shim-only tests.
- `app.*` function privileges, role inheritance, and session settings are all exercised honestly.

**Negative:**

- CI needs Postgres. A Docker service in GitHub Actions / equivalent is required.
- Local dev needs Postgres (most consumers already have one for the Prisma client).
- Tests are slower than in-memory shim tests. Mitigated by per-test transaction isolation.

## Alternatives considered

- **Shim with `pg-mem` for fast tests, real-PG for "integration":** rejected — the boundary between "unit" and "integration" RLS tests is illusory. Every meaningful policy test exercises features the shim doesn't implement. Two test types add overhead without adding coverage.
- **Snapshot-test the emitted SQL only:** rejected as the primary test layer — SQL that looks right at emit time can still misbehave at execution time (function privileges, column GRANT interaction, etc.). Kept as a complementary layer for emitter regression.

## References

- [ADR-0001 — Policy compiler, not runtime middleware](./0001-policy-compiler-not-runtime-middleware.md)
- [ADR-0014 — Phase scope boundaries](./0014-phase-scope-boundaries.md)
