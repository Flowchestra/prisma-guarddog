# example-flowchestra

End-to-end proof of `prisma-guarddog`: five representative
Flowchestra-shape models with full policy authoring on top of
`@flowchestra/prisma-guarddog-preset`.

## Models

| Model            | What it demonstrates                                     |
| ---------------- | -------------------------------------------------------- |
| `Workspace`      | Tenant scoping; role-gated mutations.                    |
| `Workbench`      | Cascaded grant from parent Workspace; `inArray` claim.   |
| `File`           | Owner-OR-role checks; column REVOKE of sensitive fields. |
| `ToolInvocation` | System-only writes (BYPASSRLS); user reads own tenant.   |
| `MigrationLedger`| `noPolicy()` opt-out (auditable "no row policy" decision). |

The full policy authoring lives in [`src/guarddog.ts`](src/guarddog.ts).
The Prisma reference schema is in [`prisma/schema.prisma`](prisma/schema.prisma).

## Tests

```bash
# Compile-pipeline coverage (always runs, no DB needed).
pnpm --filter example-flowchestra test

# Real-Postgres semantic verification (opt-in).
GUARDDOG_E2E=1 GUARDDOG_DATABASE_URL=postgres://... \
  pnpm --filter example-flowchestra test:e2e
```

The compile-pipeline tests verify that the policies compile to the
expected op stream, render the expected SQL, and pass `lintCoverage`.
The E2E tests apply that rendered SQL to a live database, seed two
tenants' worth of fixture data, and verify each policy actually
enforces what its predicate claims.
