# 0009 — Config resolution order

**Status:** Accepted
**Date:** 2026-05-23

## Context

guarddog needs to know several pieces of configuration to operate:

- Where the Prisma schema lives (`./prisma/schema.prisma` by convention, but Prisma supports overrides via `prisma.config.ts`).
- Where to write generated migrations (`./prisma/migrations/` by convention).
- Where the user's policy definitions live (no Prisma analog — guarddog-specific).
- Which Postgres dialect/version to target.
- The `metadataExt` filename for sidecars (default `.guarddog.json`).

Some of these overlap with what Prisma already configures. Duplicating configuration risks drift; ignoring Prisma's config risks pointing at the wrong files.

## Decision

Resolution order, from highest to lowest priority:

1. **Explicit `guarddog.config.ts`** — values declared here always win.
2. **`prisma.config.ts`** — guarddog reads `schema.prisma` path and migrations directory from Prisma's own config if `guarddog.config.ts` doesn't specify them.
3. **Convention** — `./prisma/schema.prisma`, `./prisma/migrations/`.

Guarddog-specific settings (policy entrypoint, sidecar extension, dialect target) have no Prisma analog and are always declared in `guarddog.config.ts`.

```ts
// guarddog.config.ts
import { defineConfig } from '@prisma-guarddog/core/config';

export default defineConfig({
  // Optional — auto-detected from prisma.config.ts or convention:
  // prismaSchema: './prisma/schema.prisma',
  // migrationsDir: './prisma/migrations',

  // Required — no Prisma analog:
  policies: './rls/policies.ts',
  dialect: 'postgres',
});
```

## Consequences

**Positive:**

- One config file, no duplication.
- Users who already configured Prisma's paths don't redeclare them for guarddog.
- Overrides remain available for projects with non-standard layouts.

**Negative:**

- Two config files exist when overrides are needed (`prisma.config.ts` and `guarddog.config.ts`). Documented in `docs/architecture/`.

## Alternatives considered

- **Require explicit paths in `guarddog.config.ts`:** rejected — duplicates Prisma's config and invites drift.
- **Read `prisma.config.ts` only; provide no guarddog config:** rejected — guarddog has settings (policies entrypoint, dialect, metadata extension) that have no Prisma equivalent.
- **Read from `package.json` `guarddog` field:** rejected — TypeScript config is consistent with the rest of the ecosystem (`prisma.config.ts`, `vitest.config.ts`, etc.).

## References

- [ADR-0010 — Migrations colocate with Prisma](./0010-migrations-colocate-with-prisma.md)
