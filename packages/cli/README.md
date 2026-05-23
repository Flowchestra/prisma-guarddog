# prisma-guarddog

The CLI. Also the npm package name for users who just want `guarddog migrate` to work.

## What lives here

- **`guarddog check`** — validate that the schema file loads and materializes cleanly. Exits 1 with a human-readable diagnostic on any failure.
- **`guarddog migrate`** — diff the schema against existing sidecars and write a fresh `prisma/migrations/<timestamp>_<slug>/` containing `migration.sql` + `guarddog.json`.
- **`prisma-guarddog-generator`** — Prisma generator binary. Drop it into `schema.prisma`'s `generator` block to bridge DMMF into the guarddog schema for autocomplete.
- **`renderOps`** — programmatic op-stream → SQL renderer. Used by `migrate`; exposed for tests and custom tooling.
- **Sidecar I/O** — `replayMigrationsDir`, `formatSidecar`, `readAllSidecarOps`, `SIDECAR_FILENAME`. Forward-replay every `guarddog.json` under `prisma/migrations/` to derive declared state.
- **Schema loader** — `loadSchema`, `materializeLoadedSchema`, `validateSchemaModule`. The jiti-backed bridge from `prisma/guarddog.ts` on disk to a `Guarddog` in memory.
- **Config** — `discoverConfig`, `resolveConfig`, `findConfigFile`, `loadConfigFile`. Resolves `guarddog.config.ts` overrides on top of the conventional defaults (`prisma/guarddog.ts`, `prisma/schema.prisma`, `prisma/migrations/`).

## Install

```sh
pnpm add -D prisma-guarddog
```

Add the generator block to your Prisma schema:

```prisma
generator guarddog {
  provider = "prisma-guarddog-generator"
}
```

## 30-second usage

```sh
# Validate the schema parses + materializes.
guarddog check

# Write the next migration.
guarddog migrate --slug initial-policies

# Apply via Prisma's standard flow — the migration folder is Prisma-shaped.
prisma migrate dev
```

`guarddog migrate` writes two files into a fresh `prisma/migrations/<timestamp>_<slug>/` folder:

- `migration.sql` — idempotent DDL that Prisma's runner picks up.
- `guarddog.json` — typed sidecar; forward-replayed on the next migrate.

## Config

Conventional defaults:

```
prisma/
├── schema.prisma          # your Prisma schema
├── guarddog.ts            # your guarddog schema (default export from defineSchema)
└── migrations/            # Prisma-shaped migrations folder
```

Override any of those via a sibling `guarddog.config.ts`:

```ts
export default {
  schemaPath: 'src/policies/guarddog.ts',
  migrationsDir: 'db/migrations',
}
```

## Where to read next

- [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) — the end-to-end compile path
- [`docs/adr/0006-sidecar-migration-metadata.md`](../../docs/adr/0006-sidecar-migration-metadata.md) — why the sidecar file exists
- [`docs/adr/0010-migrations-colocate-with-prisma.md`](../../docs/adr/0010-migrations-colocate-with-prisma.md) — why the migration folder is Prisma-shaped
- [`examples/flowchestra`](../../examples/flowchestra) — a full schema + the CLI flow exercised against it
