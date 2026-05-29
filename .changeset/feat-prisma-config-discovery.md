---
'@flowchestra/prisma-guarddog': minor
---

CLI now reads `prisma.config.ts` for path discovery. The Prisma `schema` location and `migrations.path` feed guarddog's `prismaSchemaPath` / `migrationsDir`, so guarddog follows wherever you've put your Prisma schema and migrations instead of assuming `prisma/`.

Resolution precedence (highest first): explicit `guarddog.config.ts` values → `prisma.config.ts` paths → conventional defaults (`prisma/schema.prisma`, `prisma/migrations/`). guarddog's own schema file (`prisma/guarddog.ts`) is not a `prisma.config.ts` concern and stays a guarddog convention / `guarddog.config.ts` override.

Lenient by design: a present-but-unloadable `prisma.config.ts` warns and falls back to conventions rather than failing the command. Previously this was deferred to "Phase 2"; consumers with non-default Prisma layouts no longer need to restate those paths in `guarddog.config.ts`.
