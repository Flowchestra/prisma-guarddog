# Examples

Working examples that exercise the whole compile + verify pipeline. Each example is its own workspace package — `pnpm install` at the repo root wires them up.

## Catalog

| Example | What it shows |
|---|---|
| [`flowchestra/`](./flowchestra) | Five representative production-shape policies (tenant-scoped, cascade-scoped, owner-OR-role, system-write-only, `noPolicy()` opt-out) authored on top of `@flowchestra/prisma-guarddog-preset`. Compile-pipeline tests run always; real-Postgres E2E tests run opt-in. |

More examples will land as Phase 2 features ship (FDW table coverage, row-conditional masking, importer round-trips).

## Running an example

```sh
# Always-on compile-pipeline coverage:
pnpm --filter example-flowchestra test

# Real-Postgres E2E (requires a running Postgres):
GUARDDOG_E2E=1 GUARDDOG_DATABASE_URL=postgres://… \
  pnpm --filter example-flowchestra test:e2e
```

## How an example is structured

Each example follows the same shape:

```
examples/<name>/
├── package.json           # workspace package; depends on @flowchestra/prisma-guarddog-* via workspace:*
├── tsconfig.json
├── README.md              # what this example demonstrates
├── prisma/
│   └── schema.prisma      # the Prisma side of the contract
└── src/
    ├── guarddog.ts        # the guarddog schema (defineSchema default export)
    ├── guarddog.test.ts   # always-on compile-pipeline tests
    └── e2e-postgres.test.ts # opt-in real-Postgres verification
```

The `prisma/schema.prisma` file is reference-only — examples don't run Prisma's generator. The `guarddog.ts` file is the load-bearing artifact; it's what `compileToOps` / `renderOps` operate on and what `loadSchema` would import in a real consumer.
