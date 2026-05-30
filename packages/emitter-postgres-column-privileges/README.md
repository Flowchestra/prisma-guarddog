# @flowchestra/prisma-guarddog-emitter-postgres-column-privileges

Pure AST → Postgres SQL transformer for **static, role-based** column-level GRANT/REVOKE.

Row-conditional field masking (`.masks()` / `.projection()`) is a distinct Phase 2 primitive — see [ADR-0004](../../docs/adr/0004-column-privileges-vs-row-conditional-masking.md).

## What lives here

- `emitColumnPrivileges(ast, ctx)` — `ColumnPrivilegeAst` → `GRANT SELECT (col) ON table TO role;` statements.
- `quoteIdent`, `resolveTableName`, `defaultTableResolver` — dialect helpers, same shape as the RLS emitter's so the CLI's renderer can use either interchangeably.

## Install

```sh
pnpm add @flowchestra/prisma-guarddog-emitter-postgres-column-privileges
```

Like the RLS emitter, you usually do not need to import this directly — the CLI's `renderOps` dispatches to it for `grant-column` / `revoke-column` ops.

## 30-second usage

```ts
import { emitColumnPrivileges } from '@flowchestra/prisma-guarddog-emitter-postgres-column-privileges'

// In your guarddog.ts:
guard.model('File').columnPrivileges({
  storageKey:       { select: ['app_system'], update: ['app_system'] },
  embeddingPayload: { select: ['app_system'] },
})

// Programmatic emit:
for (const ast of guard.getColumnPrivileges()) {
  for (const stmt of emitColumnPrivileges(ast)) console.log(stmt)
}
```

## Idempotency

`GRANT` and `REVOKE` are natively idempotent in Postgres — no wrapper needed.

## Known gap — column-level GRANTs are not self-enforcing

A column-level `GRANT` does **not** restrict access on its own: any pre-existing table-level `GRANT` (or a `PUBLIC` default) supersedes it. Until guarddog emits a base-table `REVOKE` prelude ([ADR-0027](../../docs/adr/0027-column-privilege-enforcement-gap.md), [issue #2](https://github.com/Flowchestra/prisma-guarddog/issues/2)), the consumer must withhold table-level privileges and grant only the allowed columns. The lint package raises `column-privilege-unenforced` to stop the gap from failing silently. The base-table REVOKE prelude lands in Phase 2.

## Where to read next

- [`docs/adr/0004-column-privileges-vs-row-conditional-masking.md`](../../docs/adr/0004-column-privileges-vs-row-conditional-masking.md) — what this package does and does not cover
- [`docs/adr/0027-column-privilege-enforcement-gap.md`](../../docs/adr/0027-column-privilege-enforcement-gap.md) — the enforcement gap and the planned fix
- [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) — fit with core's `ColumnPrivilegeAst` and the CLI's renderer
