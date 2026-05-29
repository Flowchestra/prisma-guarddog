# 0028 — Typed model + column references (`model()` / `p.col()` autocomplete)

**Status:** Accepted (implemented)
**Date:** 2026-05-29

## Context

Authoring is typed for claims (`p.claim`), grant-table hints (`p.hasGrant(..., { table })`, ADR-0025), and managed functions (`p.fn`, ADR-0026) — but **model and column references are not**:

- `guard.model('Workspace')` takes a plain `string`; a typo'd model name is silently accepted.
- `col('tenant_id')` takes a plain `string`; a typo'd or non-existent column is silently accepted and only surfaces as a Postgres error at apply time.

The generated [`guarddog-models.ts`](../../packages/importer-prisma/src/codegen.ts) emits a `ModelName` union + `ModelTables` map from DMMF, but `model()`'s signature is still `string` and **columns have no typing at all**. This is the largest remaining DX gap and the most error-prone (column names are the most-typed, least-checked surface in a policy).

**Why not import Prisma's generated client types?** Two reasons:

1. **Wrong granularity for SQL.** Prisma's generated model types key on **field names** (`keyof Workspace` → `tenantId`). guarddog's `col()` is a **SQL column reference** — under `@map`/`@@map` the DB column differs from the Prisma field. The correct column universe is DMMF's `field.dbName`, which Prisma's generated *TS* types don't expose. Reusing `Prisma.*` types for `col()` would be subtly wrong the moment `@map` is used.
2. **Import coupling.** The new `prisma-client` generator outputs to a consumer-chosen path imported relatively (not a stable `@prisma/client`). guarddog core stays Prisma-agnostic and cannot hardcode that import.

So we reuse Prisma's work via **DMMF** (the right source for SQL-level names), not its generated client types — consistent with how the rest of guarddog already consumes DMMF.

## Decision

Thread a model→columns type map through the builder chain so `model()` and a new model-scoped `p.col()` autocomplete and type-check, sourced from DMMF `dbName`. Defaults keep everything backward compatible.

**1. Codegen — emit a column map (as a value, for inference).** Extend `generateModelTypes` to also emit, alongside `Models`/`ModelName`/`ModelTables`, a `ModelColumns` **const** plus a derived `GuarddogModels` type:

```ts
/** Prisma model -> its SQL columns (DMMF dbName). Pass to `defineSchema({ models: ModelColumns })`. */
export const ModelColumns = {
  Workbench: ['id', 'ownerId', 'workspaceId'],
  Workspace: ['id', 'name', 'tenantId'],
} as const

export type GuarddogModels = { readonly [K in keyof typeof ModelColumns]: (typeof ModelColumns)[K][number] }
```

Columns are the model's non-relation fields (`field.kind !== 'object'`), each `field.dbName ?? field.name` — the actual SQL column. Deterministic (sorted) for clean diffs. Emitting a **const** (not just a type) is what enables inference (below).

**2. Generics + inference.** Add a `TModels extends Record<string, string>` generic (model name → column-name union) to `Guarddog` / `SchemaDefinition` / `materializeSchema`, defaulting to `Record<string, string>` (unconstrained). The consumer opts in by passing the generated const to a new optional `models` field — **no explicit type argument** (guarddog has too many generics for `defineSchema<...>` to target the right slot; a value infers cleanly):

```ts
import { ModelColumns } from './generated/guarddog-models'
export default defineSchema({ models: ModelColumns, /* ... */ })
```

`defineSchema` infers `TModelColumns` from the `models` const and maps it to the union form via `ColumnUnionMap<T> = { [K in keyof T]: T[K][number] }`. Then:

- `model<M extends keyof TModels & string>(name: M)` — typed model names; returns a `ModelBuilder` scoped to the column union `TModels[M]`.
- That column union threads `ModelBuilder → PolicyBuilder → PredicateBuilder` as a new `TColumns` generic (defaults `string`). The internal builder registries are keyed loosely (`string` columns) and the precise union rides on the fluent return types via localized `as unknown as` casts — runtime is identical.

**3. `p.col()` — the typed, model-scoped column reference.** Add `col(name: TColumns): FluentExpr` to `PredicateBuilder`. Inside `select((p) => …)`, `p.col('…')` autocompletes the current model's columns and rejects typos; it returns a `FluentExpr` so it's a drop-in everywhere (`p.col('x').eq(…)`, `p.hasGrant('read', p.col('workspaceId'))`, `p.isOwner(p.col('ownerId'))`).

**4. Standalone `col()` stays** as the untyped escape hatch — for dynamic column names, raw migration scaffolding, or consumers who don't generate the map. `p.col` is the typed path; `col` is the unconstrained one. Both produce identical AST.

**5. Polymorphic** threads the *target* model's column union into each target's predicate builder (the policy authors against the target's columns).

**Field-vs-column note.** The map uses `dbName`, so `p.col` autocompletes SQL column names — matching what the emitter quotes into the DDL. This is correct under `@map`; it does mean `p.col` surfaces DB names, not Prisma field names (a deliberate, SQL-truthful choice for a SQL policy tool).

## Implementation plan

1. **Codegen** (`importer-prisma`): extend `PrismaModel` to carry `columns: readonly string[]` (from DMMF, non-relation, `dbName ?? name`); extend `generateModelTypes` to emit the `ModelColumns` const + derived `GuarddogModels` type; update `parsePrismaModels` + the generator. Tests: golden output incl. an `@map`'d column.
2. **Core generics**: add `TColumns` to `PredicateBuilder` + `p.col`; add `TModels` to `Guarddog`/`ModelBuilder`/`PolicyBuilder` and thread `TModels[M]` from `model()` into the policy's predicate builder (PolicyBuilder constructs `PredicateBuilder<…, TColumns>`). Mirror through `polymorphic.ts`. Add `TModels` to `defineSchema`/`materializeSchema`.
3. **Type-level tests** (`@ts-expect-error`): `model('typo')` errors; `p.col('ghost')` errors; `p.col('tenantId')` OK; unconstrained default (`string`) still accepts any column — backward compat pinned.
4. **Runtime**: none — `p.col` builds the same `col` AST node; purely additive types.
5. **Docs + example**: ADR (this), README authoring snippet, and demonstrate `defineSchema({ models: ModelColumns })` + `p.col` as the reference pattern. Changeset: minor `core` + `importer-prisma`.

## Consequences

**Positive**
- Column typos become compile errors instead of apply-time Postgres errors — the highest-value, most error-prone surface finally typed, consistent with claims/fn/grant-hint typing.
- Reuses Prisma's DMMF (its real work) at the correct SQL granularity; no dependency on Prisma's generated client types or their import path.
- Fully backward compatible: `TModels`/`TColumns` default to unconstrained, standalone `col()` is untouched, and `p.col` is purely additive (no runtime change).

**Negative**
- Two column helpers (`col` vs `p.col`). Mitigated by a clear rule: `p.col` for typed/model-scoped, `col` for dynamic/raw. Opt-in autocomplete requires rewriting `col(...)` → `p.col(...)` in predicates.
- One more thing to wire: pass `models: ModelColumns` (and run codegen to produce it). Inferred from the const, so no explicit generic — but the typing is only as fresh as the last `prisma generate`.
- `p.col` surfaces DB column names (post-`@map`), not Prisma field names — correct for SQL, but a consumer used to thinking in Prisma field names must map mentally. Documented.

## Alternatives considered

- **Import Prisma's generated client types for `col()`.** Field-keyed (wrong under `@map`) + import-path-coupled. Rejected — see Context.
- **Type the standalone `col()` directly.** Impossible to scope to "the current model" — `col` is a free function with no model context. Rejected; `p.col` is the model-bound equivalent.
- **`select((p, col) => …)` (typed `col` as a 2nd callback arg).** Avoids the `p.col` namespace but changes every predicate callback signature and is less consistent with `p.claim`/`p.fn`. Rejected in favor of `p.col`.
- **Global union of all columns across all models for `col()`.** Loses per-model scoping (would accept another model's column). Rejected.
- **Type only `model()` now, defer columns.** Cheaper, but leaves the high-value gap (columns) open. Folded into this single design instead.
- **Explicit `defineSchema<GuarddogModels>(...)` type argument** (the original design sketch). guarddog's `defineSchema` has 7+ generics, so a single explicit arg binds to the wrong (first) slot; making `TModels` first would force defaults on all the others and reorder the signature. Rejected in favor of value-inference from the `models` const — zero explicit generics, better DX.

## References

- [ADR-0015 — TypeScript as the DSL](./0015-typescript-as-dsl.md)
- [ADR-0025 — `hasGrant` per-call table hint](./0025-hasgrant-per-call-table-hint.md) — the generic-threading pattern this mirrors
- [ADR-0026 — guarddog-managed SQL functions](./0026-managed-sql-functions.md) — same `TFunctions` threading shape
- [`packages/importer-prisma/src/codegen.ts`](../../packages/importer-prisma/src/codegen.ts) — `generateModelTypes`
- [`packages/core/src/predicate.ts`](../../packages/core/src/predicate.ts) — `col`, `PredicateBuilder`
