# @prisma-guarddog/importer-prisma

Prisma DMMF readers and model-type codegen. Bridges the Prisma side of the contract into the guarddog schema for autocomplete and for the lint coverage check.

## What lives here

- **`runGuarddogGenerator(options)`** — library-side handler for the Prisma generator binary. The actual binary (`prisma-guarddog-generator`) lives in the CLI package; this is the pure(-ish) function it delegates to.
- **`generateModelTypes(models)`** — DMMF model list → TypeScript module exporting model-name and table-name literal unions plus a `ModelTables` map.
- **`parsePrismaModels(dmmf)` / `readPrismaModels(schemaPath)`** — pull the model list out of a DMMF object or load it from a schema file via `@prisma/internals.getDMMF`.
- **`resolveGeneratorOutputPath`** — resolves the user-specified `output` path on a Prisma generator block (or returns the default).

## Install

```sh
pnpm add -D @prisma-guarddog/importer-prisma
```

Add the generator block to your Prisma schema (this points at the CLI's binary, which re-exports `runGuarddogGenerator`):

```prisma
generator guarddog {
  provider = "prisma-guarddog-generator"
  output   = "../src/generated/guarddog-models.ts"  // optional
}
```

Every `prisma generate` writes a `guarddog-models.ts` file containing:

```ts
export type GuarddogModelName = 'Workspace' | 'Workbench' | 'File' | …
export type GuarddogTableName = 'workspace' | 'workbench' | 'file' | …
export type ModelTables = { Workspace: 'workspace'; Workbench: 'workbench'; … }
```

…which the guarddog schema can re-use for type-safe `.model(name)` and table-resolver overrides.

## Where to read next

- [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) — where the importer slots in
- [`docs/adr/0012-scaffold-only-importer.md`](../../docs/adr/0012-scaffold-only-importer.md) — the importers' contract (this one ALSO informs the lint package)
- [`@prisma-guarddog/lint`](../lint) — coverage check consumes the model list this importer produces
