# @prisma-guarddog/emitter-postgres-rls

Pure AST → Postgres SQL transformer for RLS policies and role lifecycle. No I/O, no DB connection.

## What lives here

- `emitPolicy(policyAst, ctx)` — `PolicyAst` → idempotent `DROP POLICY IF EXISTS … ; CREATE POLICY …` statements per declared verb.
- `emitPolymorphic(polyAst, ctx)` — expands per-target with discriminator equality fused into the `USING`/`WITH CHECK` clauses.
- `emitRoles(dbRoles)` — `CREATE ROLE` + `GRANT … TO …` wrapped in `pg_roles` / `pg_auth_members`-guarded DO blocks.
- `compileExpr(expr, exprCtx)` — `Expr` tree → SQL fragment. The pluggable seams (`compileHasAppRole`, `compileHasGrant`, `compileHasResourcePermission`, `compileIsOwner`) let consumers swap the layer-2/3 lookup strategy without forking the emitter.
- `quoteIdent`, `quoteString`, `formatLiteral`, `defaultTableResolver`, `policyName` — dialect helpers; reused by the CLI's `renderOps`.

## Install

```sh
pnpm add @prisma-guarddog/emitter-postgres-rls
```

You usually do **not** import this directly — the CLI's `renderOps` already orchestrates per-op rendering. Reach for the package only if you're building a custom migration writer or a different dialect emitter.

## 30-second usage

```ts
import { compileExpr, emitPolicy, emitRoles } from '@prisma-guarddog/emitter-postgres-rls'

const rolesDdl = emitRoles(guard.config.dbRoles) // CREATE ROLE … DO blocks
const policyDdl = emitPolicy(policy, {
  claims: guard.config.claims,
  resourceGrants: guard.config.resourceGrants,
})
```

## Idempotency

Per [ADR-0008](../../docs/adr/0008-idempotent-ddl-emission.md) every statement is safe to re-run:

- `ENABLE / FORCE ROW LEVEL SECURITY` — natively idempotent.
- `CREATE POLICY` — preceded by `DROP POLICY IF EXISTS`.
- `CREATE ROLE` / `GRANT membership` — wrapped in DO blocks that check `pg_roles` / `pg_auth_members` first.

## Where to read next

- [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) — how the emitter slots into the compile path
- [`docs/adr/0005-explicit-using-and-with-check.md`](../../docs/adr/0005-explicit-using-and-with-check.md) — why USING and WITH CHECK are never inferred
- [`docs/adr/0008-idempotent-ddl-emission.md`](../../docs/adr/0008-idempotent-ddl-emission.md) — the re-run contract
