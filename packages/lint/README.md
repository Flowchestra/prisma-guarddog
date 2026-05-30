# @flowchestra/prisma-guarddog-lint

Coverage + WIP + adoption-hygiene checks: catches "I added a Prisma model and forgot to write a policy" — the exact class of bug RLS itself can't help with if the model has no policy at all — plus the long-tail rot signals from the adoption path.

## What lives here

- **`lintCoverage({ guard, prismaModels })`** — cross-reference a `Guarddog` instance against a Prisma model list and return a `LintReport`. Issue kinds:
  - `error / missing-coverage` — Prisma model has no `policy()`, `polymorphic()`, or `noPolicy()` declaration.
  - `warning / todo-marker` — policy carries unresolved `.todo()` calls (scaffold-import residue).
  - `warning / raw-sql-policy` — policy uses `rawSql()` for some verb (replace with a typed predicate).
  - `warning / column-privilege-unenforced` — `.columnPrivileges()` declared but the base-table REVOKE prelude isn't emitted yet ([ADR-0027](../../docs/adr/0027-column-privilege-enforcement-gap.md), [issue #2](https://github.com/Flowchestra/prisma-guarddog/issues/2)).
  - `warning / policy-uses-declared-name` — verb spec carries a `.named(...)` or per-verb `{ name }` override ([ADR-0031](../../docs/adr/0031-user-declared-policy-names.md)). Surfaces the auto-gen target so authors converge back on the convention once adoption is complete — declared names are a transitional escape hatch, not an aesthetic preference.

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

The CLI wires this in via `guarddog check --lint` — wraps `lintCoverage` against the DMMF-sourced Prisma model list and exits non-zero on any error-severity issue. Call `lintCoverage` directly from a test or CI script if you need finer control.

## Where to read next

- [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) — where lint fits relative to the importer and CLI
- [`@flowchestra/prisma-guarddog-importer-prisma`](../importer-prisma) — generate the `prismaModels` argument from DMMF
