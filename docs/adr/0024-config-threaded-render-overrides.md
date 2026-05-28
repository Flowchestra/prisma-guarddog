# 0024 — Config-threaded render overrides + override-authoring ergonomics

**Status:** Accepted
**Date:** 2026-05-28

## Context

`compileHasGrant` (and the sibling `compileHasAppRole` / `compileHasResourcePermission` / `compileIsOwner`) is the documented escape hatch for consumers whose authorization model doesn't fit the built-in templates. It's accepted by `renderOps`'s `RenderContext` and wins over source-based dispatch. But three gaps made it painful to actually use through the shipped CLI (issues #7, #8, #9):

1. **The CLI didn't thread overrides.** `planMigrate` / `runMigrate` only passed `claims` + `resourceGrants` to `renderOps`. A consumer with an override had to reimplement the migrate pipeline — Flowchestra's `scripts/guarddog-migrate.ts` was an ~80-line copy of `runMigrate` differing only in the `renderOps` call.
2. **`principalClaim` was table-source-only.** An override using `source: 'claims'` (the minimal declaration) couldn't read `ctx.resourceGrants.principalClaim` and had to hardcode the claim name.
3. **The compiler types weren't re-exported** from the package consumers install, forcing a `NonNullable<RenderContext[...]>` extraction or a dep on the internal emitter package.

## Decision

Three coordinated changes that make the override path first-class:

1. **`renderOverrides` in `guarddog.config.ts` (#8).** `GuarddogConfigFile` gains an optional `renderOverrides` (the four compilers, factored into a `RenderOverrides` type). `resolveConfig` threads it onto `ResolvedConfig` (defaulting to `{}`); `runMigrate` / `diff` / `emit` forward `config.renderOverrides` into `planMigrate`, which spreads it into the `renderOps` call. The config file is already jiti-loaded, so it can carry functions. Stock `guarddog migrate` now honors overrides; the consumer-side migrate script disappears.

2. **`principalClaim` on `source: 'claims'` (#7).** Both variants of `ResourceGrantsDefinition` now carry `principalClaim` (default `'sub'`), so an override reads `ctx.resourceGrants.principalClaim` regardless of source and stays generic over the claim name. The built-in claims compiler doesn't consume it (claim-based `hasGrant` checks the grants jsonb directly), but the field is now available for overrides — matching the config-vs-override responsibility split.

3. **Re-export compiler types from the CLI package (#9).** `HasGrantCompiler` & friends are re-exported from `@flowchestra/prisma-guarddog` (where `RenderContext` already lives and which is what consumers install).

## Consequences

**Positive**
- A consumer with custom authz writes one `compileHasGrant`, points `guarddog.config.ts` at it, and uses the stock CLI. No pipeline reimplementation.
- Override code is generic over claim name (no hardcoded `'sub'` / `'user_id'`).
- Type imports come from the installed package.

**Negative**
- `guarddog.config.ts` now legitimately carries executable code (compiler functions), not just paths. It always could (jiti), but this blesses the pattern — a malicious or buggy config runs at migrate time. Acceptable: the config is consumer-authored, same trust level as the schema file.
- Override compilers bypass guarddog's typed-predicate guarantees for the predicates they emit; lint's `raw-sql-policy` signal doesn't see them. Consumers trade safety for expressiveness knowingly — that's the escape hatch's nature.

## Alternatives considered

- **A separate `prisma/guarddog.overrides.ts` magic file (#8 option B).** Another discovered filename vs. extending the existing `guarddog.config.ts`. Rejected — centralizing in the config we already load is less surface.
- **Re-export compiler types from core instead of CLI (#9).** Defensible (core is the root), but `RenderContext` lives in the CLI package and the CLI is what consumers install, so co-locating the types there is the natural reach. Chosen.

## References

- Issues #7, #8, #9
- [ADR-0021 — Table-backed resource grants](./0021-table-backed-resource-grants.md), [ADR-0020 — Functional lifecycle](./0020-functional-lifecycle-over-op-union.md)
- [`packages/cli/src/config.ts`](../../packages/cli/src/config.ts), [`packages/cli/src/commands/migrate.ts`](../../packages/cli/src/commands/migrate.ts), [`packages/cli/src/render-ops.ts`](../../packages/cli/src/render-ops.ts)
