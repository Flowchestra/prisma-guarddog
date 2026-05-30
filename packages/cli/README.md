# prisma-guarddog

The CLI. Also the npm package name for users who just want `guarddog migrate` to work.

## What lives here

### Commands

- **`guarddog check`** — validate that the schema file loads and materializes cleanly. With `--lint`, also runs coverage + WIP + declared-name checks. Exits 1 with a human-readable diagnostic on any failure.
- **`guarddog migrate`** — diff the schema against existing sidecars and write a fresh `prisma/migrations/<timestamp>_<slug>/` containing `migration.sql` + `guarddog.json`. `--drop-unmanaged --against <url>` cuts over foreign/legacy policies in the same migration.
- **`guarddog emit`** — render the current schema's full DDL to stdout or `--out <file>`. Useful for snapshot tests and ad-hoc inspection without writing a migration.
- **`guarddog diff`** — show what the next migration would contain (op summary + SQL preview) without writing anything.
- **`guarddog drift --against <url>`** — read live `pg_policies`, classify against the declared schema, and report `foreign` / `staleManaged` / `missing` / `restrictivenessMismatch` / `acknowledged` ([ADR-0029](../../docs/adr/0029-handling-existing-rls-policies.md)). Read-only. `--exit-code` to gate CI.
- **`guarddog adopt --against <url>`** — interactively triage every foreign policy: `keep` / `remove` / `edit` / `override` / `skip`. Stamps `:ignore` for keeps, drops for removes, scaffolds TS files for edits/overrides ([ADR-0030](../../docs/adr/0030-interactive-adoption-triage.md)).
- **`guarddog import --against <url>`** — bulk scaffold-only import from a live database. Emits `rawSql() + .todo()` TS stubs you can fold into `guarddog.ts`. Distinct from `adopt`: `import` is bulk and non-interactive; `adopt` is per-policy and interactive.
- **`prisma-guarddog-generator`** — Prisma generator binary. Drop it into `schema.prisma`'s `generator` block to bridge DMMF into the guarddog schema for autocomplete.

### Library surface

- **`renderOps`** — programmatic `Op[]` → SQL renderer. Used by `migrate`; exposed for tests and custom tooling. Stamps the `prisma-guarddog:managed` ownership comment on every emitted policy.
- **Drift + adoption** — `computePolicyDrift`, `planAdoption`, `driftToDropOps`. Pure functions over a `State` and the live policy inventory; the CLI commands are thin wrappers.
- **Sidecar I/O** — `replayMigrationsDir`, `formatSidecar`, `readAllSidecarOps`, `SIDECAR_FILENAME`. Forward-replay every `guarddog.json` under `prisma/migrations/` to derive declared state.
- **Schema loader** — `loadSchema`, `materializeLoadedSchema`, `validateSchemaModule`. The jiti-backed bridge from `prisma/guarddog.ts` on disk to a `Guarddog` in memory.
- **Config** — `discoverConfig`, `resolveConfig`, `findConfigFile`, `loadConfigFile`. Resolves `guarddog.config.ts` overrides on top of the conventional defaults (`prisma/guarddog.ts`, `prisma/schema.prisma`, `prisma/migrations/`).

## Install

```sh
pnpm add -D @flowchestra/prisma-guarddog
```

Add the generator block to your Prisma schema:

```prisma
generator guarddog {
  provider = "prisma-guarddog-generator"
}
```

## 30-second usage

```sh
# Validate the schema parses + materializes. Add --lint for coverage + WIP checks.
guarddog check --lint

# Write the next migration.
guarddog migrate --slug initial-policies

# Apply via Prisma's standard flow — the migration folder is Prisma-shaped.
prisma migrate dev
```

`guarddog migrate` writes two files into a fresh `prisma/migrations/<timestamp>_<slug>/` folder:

- `migration.sql` — idempotent DDL that Prisma's runner picks up.
- `guarddog.json` — typed sidecar; forward-replayed on the next migrate.

## Adopting an existing database

```sh
# 1. Report (read-only).
guarddog drift --against "$DATABASE_URL" --exit-code

# 2. Interactively triage every foreign policy.
guarddog adopt --against "$DATABASE_URL"

# 3. Bulk-import everything else as scaffolds.
guarddog import --against "$DATABASE_URL" --out src/policies/imported.ts

# 4. Cut over — DROP foreign/legacy policies + apply guarddog's in one migration.
guarddog migrate --drop-unmanaged --against "$DATABASE_URL" --slug rls-cutover
```

Conservative by default: `migrate` never drops a foreign policy without `--drop-unmanaged`, and `adopt` only writes per-policy decisions you confirm.

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

- [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) — the greenfield compile path **and** the brownfield adoption path
- [`docs/adr/0006-sidecar-migration-metadata.md`](../../docs/adr/0006-sidecar-migration-metadata.md) — why the sidecar file exists
- [`docs/adr/0010-migrations-colocate-with-prisma.md`](../../docs/adr/0010-migrations-colocate-with-prisma.md) — why the migration folder is Prisma-shaped
- [`docs/adr/0029-handling-existing-rls-policies.md`](../../docs/adr/0029-handling-existing-rls-policies.md) — drift detection, ownership comments, `--drop-unmanaged`
- [`docs/adr/0030-interactive-adoption-triage.md`](../../docs/adr/0030-interactive-adoption-triage.md) — the `adopt` dispositions
- [`examples/flowchestra`](../../examples/flowchestra) — a full schema + the CLI flow exercised against it
