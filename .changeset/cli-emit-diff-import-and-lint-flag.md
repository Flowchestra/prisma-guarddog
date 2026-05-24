---
'@flowchestra/prisma-guarddog': minor
---

CLI: add `emit`, `diff`, `import` subcommands and a `--lint` flag on `check`.

- `guarddog emit` — render the entire schema as SQL to stdout (or `--out <file>`). Read-only; touches no migrations. Useful for ad-hoc inspection or piping the full Op set into psql.
- `guarddog diff` — preview what the next `guarddog migrate` would write, without writing anything. Pass `--exit-code` to fail when there are pending changes (CI drift gate).
- `guarddog import` — connect to a live Postgres (`--url <conn-string>`) and scaffold a `guarddog.ts` from `pg_policies` + column privileges. Output uses `rawSql()` + `.todo()` markers per ADR-0012; review before committing. Requires `pg` (declared as an optional peerDependency).
- `guarddog check --lint` — cross-reference the loaded `Guarddog` against the consumer's Prisma DMMF and fail on any model without `.policy()` / `.polymorphic()` / `.noPolicy()` coverage. The bug class RLS itself cannot catch.

Each command has a matching programmatic export — `runEmit`, `runDiff`, `runImport` — for editor integrations and scripting.
