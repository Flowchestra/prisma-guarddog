---
'@flowchestra/prisma-guarddog': patch
'@flowchestra/prisma-guarddog-core': patch
'@flowchestra/prisma-guarddog-emitter-postgres-rls': patch
'@flowchestra/prisma-guarddog-emitter-postgres-column-privileges': patch
'@flowchestra/prisma-guarddog-importer-prisma': patch
'@flowchestra/prisma-guarddog-importer-postgres': patch
'@flowchestra/prisma-guarddog-testing-postgres': patch
'@flowchestra/prisma-guarddog-lint': patch
'@flowchestra/prisma-guarddog-preset': patch
---

Two bug fixes surfaced by running the end-to-end suite for the first time.

**All packages:** add a `default` condition to every workspace package's `exports` field. Previously only `types` + `import` were declared — jiti (used by the CLI's `loadSchema`) requests the `default` condition during CJS-flavored resolution, so any `prisma/guarddog.ts` that lived outside the workspace tree failed to load workspace packages with `No "exports" main defined`. This was a latent bug for every downstream consumer; surfaced when the `guarddog` CLI was pointed at a schema file in a tmpdir.

**`importer-postgres`:** correctly parse `pg_policies.roles` when node-postgres returns the `name[]` column as a raw Postgres array literal (`{role1,role2}`) instead of a JS array. The previous code did `[...row.roles]`, which spread the string to characters and made `dbRole === '{'` for every imported policy. A new `parseRolesField` helper accepts both shapes and handles double-quoted entries.
