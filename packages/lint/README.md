# @flowchestra/prisma-guarddog-lint

Coverage check: catches "I added a Prisma model and forgot to write a policy" — the exact class of bug RLS itself can't help with if the model has no policy at all.

## What lives here

- **`lintCoverage({ guard, prismaModels })`** — cross-reference a `Guarddog` instance against a Prisma model list and return a `LintReport`. Three issue families:
  - `error / missing-coverage` — Prisma model has no `policy()`, `polymorphic()`, or `noPolicy()` declaration.
  - `warning / todo-marker` — policy carries unresolved `.todo()` calls.
  - `warning / raw-sql-policy` — policy uses `rawSql()` for some verb (Phase 2 cleanup signal).

A model is considered covered if any of: has at least one `PolicyAst`, appears as a `PolymorphicAst` target, is a `PolymorphicAst` itself, or has a `NoPolicyAst` with a non-empty reason.

Output is sorted by `(model, severity, kind)` so PR diffs stay deterministic.

## Install

```sh
pnpm add -D @flowchestra/prisma-guarddog-lint
```

## 30-second usage

```ts
import { materializeSchema } from '@flowchestra/prisma-guarddog-core'
import { lintCoverage } from '@flowchestra/prisma-guarddog-lint'
import schema from './prisma/guarddog.ts'

const guard = materializeSchema(schema)
const report = lintCoverage({
  guard,
  prismaModels: [
    { name: 'Workspace' },
    { name: 'Workbench' },
    { name: 'File' },
    // …or generate this list from your DMMF via @flowchestra/prisma-guarddog-importer-prisma
  ],
})

if (!report.ok) {
  for (const issue of report.issues) {
    console.error(`[${issue.severity}] ${issue.modelName}: ${issue.detail}`)
  }
  process.exit(1)
}
```

The CLI does not yet wire this in as a subcommand — call it programmatically from your existing test or CI script for now.

## Where to read next

- [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) — where lint fits relative to the importer and CLI
- [`@flowchestra/prisma-guarddog-importer-prisma`](../importer-prisma) — generate the `prismaModels` argument from DMMF
