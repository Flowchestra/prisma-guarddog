# 0017 — TypeScript implementation; no compiled binary

**Status:** Accepted
**Date:** 2026-05-23

## Context

Schema- and migration-related tooling has a strong prior art in compiled binaries: Atlas (Go), sqlc (Go), dbmate (Go), refinery (Rust), sqitch (Perl). A binary has appealing properties: fast CLI startup, single-file distribution, no transitive dependency tree, smaller supply-chain attack surface.

The question is whether `prisma-guarddog` should be a TypeScript package distributed via npm, or a Go/Rust binary distributed via `cargo install` / `go install` / `curl | sh`.

The decision hinges on what guarddog must consume:

- The consumer's TypeScript policy file (typed against `Prisma.<Model>ScalarFieldEnum`)
- Prisma's DMMF (a JavaScript object graph exposed by `@prisma/internals`)
- The consumer's `prisma.config.ts` (TypeScript)
- The consumer's `guarddog.config.ts` (TypeScript)
- Test integration via the consumer's vitest/jest test files (TypeScript / JavaScript)

Every input is TypeScript-native or JavaScript-native. None of it has a stable non-JS API.

## Decision

`prisma-guarddog` is implemented in TypeScript, published to npm. The CLI binary is shipped via npm's `bin` field, not as a standalone Go/Rust executable.

A future Phase 3+ NAPI escape hatch is permitted: individual emitter packages may be rewritten in Rust and exposed via `napi-rs`, distributed as platform-tagged optional dependencies inside the same npm package. This is **only** done if measurement justifies it; it is not preemptive.

## Consequences

**Positive:**

- The DSL — TypeScript typed against Prisma model fields — is consumed natively. No serialization boundary.
- Prisma DMMF is read directly via `@prisma/internals`. No shelling out, no schema reparsing.
- Test integration lives inside the consumer's existing TS test runner. No external process to coordinate.
- Distribution path is identical to every other tool the consumer already uses: `pnpm add prisma-guarddog`.
- No cross-platform binary builds, no `postinstall` curl-pipe-bash, no platform-specific bundles.

**Negative:**

- CLI startup is slower than a static binary (~200ms cold vs <10ms). Acceptable: guarddog runs at migration-author time, not in the request path.
- Larger transitive dependency tree than a static binary. Mitigated by keeping the core package's runtime dependencies minimal.

## Alternatives considered

- **Go binary:** rejected. The only way to consume the consumer's TypeScript policy file is to either (a) make policies non-TS — regression to ZModel territory; see [ADR-0015](./0015-typescript-as-dsl.md), (b) shell out to Node anyway — defeats the binary's purpose, or (c) embed a JS runtime — heavy and reinvents Node. None of these are wins.
- **Rust binary (standalone):** rejected for the same reasons as Go. No good story for evaluating the TS policy file.
- **Rust + NAPI from day 1:** rejected — complicates the Phase 1 build pipeline for no measured benefit. CLI startup time is not the bottleneck; emit time across 100 tables is dominated by I/O and Prisma migrate orchestration, not by emitter parsing. The escape hatch above remains available if measurement ever inverts this conclusion.
- **Deno-distributed TypeScript binary:** rejected — Deno's `deno compile` produces a binary but the consumer ecosystem is npm/pnpm/Node. Adding Deno as a runtime introduces friction without a corresponding benefit.

## References

- [ADR-0015 — TypeScript as the DSL](./0015-typescript-as-dsl.md)
- [ADR-0016 — Turborepo monorepo](./0016-turborepo-monorepo.md)
