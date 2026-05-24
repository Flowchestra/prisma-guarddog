# 0020 — Functional lifecycle over an Op-union state, not instance methods on `Guarddog`

**Status:** Accepted
**Date:** 2026-05-23

## Context

Early drafts of `PLAN.md` and the project's design notes described the compile/diff/migrate pipeline as **instance methods on the `Guarddog` class**: `guard.emit()`, `guard.diff(previous)`, `guard.migrate({ slug })`. Reading from outside the project, this looked natural — `Guarddog` is where policies get registered, so a contributor would expect the lifecycle to live on the same object.

As the pipeline took shape during Phase 1 implementation, three forces pushed against that framing:

1. **State is not the `Guarddog` instance.** What we diff is a `State` value — a typed snapshot of policies, role memberships, and column grants — derived from compiling a `Guarddog`. The same `Guarddog` instance can compile to multiple states (e.g., with different table-naming overrides), so methods that bake "the state" into the instance overstate the coupling.
2. **The CLI never has just one `Guarddog`.** `guarddog migrate` needs to compute *current* state from the live schema file and *previous* state from replaying sidecars on disk. With instance methods, that means either constructing a synthetic `Guarddog` from sidecars (it isn't one — sidecars don't carry the original policy DSL) or threading state through `this` in unnatural ways.
3. **Testability.** Pure functions over a typed `State` are trivial to test in isolation. Instance methods that mutate or memoize over `this` add a per-test setup cost and surface implicit state we'd rather not have.

ADR-0006 (sidecar migration metadata) and ADR-0007 (forward-replay state derivation) already pointed in this direction by treating cumulative state as a *value* you derive from previous sidecars + the current schema. ADR-0020 captures the API-level consequence.

## Decision

The lifecycle in `@flowchestra/prisma-guarddog-core` is **a set of pure functions over an Op-union `State` value**, exported from `lifecycle.ts`:

- `compileToOps(guard): Op[]` — compile a `Guarddog` instance to its flat Op-union form.
- `compileToState(guard): State` — fold the Op list into a `State` snapshot.
- `diffStates(prev, next): Op[]` — produce the minimum forward Op list to move from `prev` to `next`.
- `applyOps(state, ops): State` — apply a sequence of Ops to a base state (used both during forward-replay and tests).

The CLI layer composes these into `planMigrate` / `runMigrate` (in `@flowchestra/prisma-guarddog`), which add file I/O — reading prior sidecars, writing the new migration directory — without mutating core values.

The `Guarddog` class **does not** expose `.emit()`, `.diff()`, or `.migrate()` instance methods. Authoring methods (`.model()`, `.policy()`, `.columnPrivileges()`, `.polymorphic()`, `.noPolicy()`, `.rawSql()`, `.todo()`) remain instance methods because they take only the `Guarddog` registry as their target — they don't need a separate state value.

## Consequences

**Positive**

- The `Guarddog` class stays narrowly about *authoring*. The lifecycle operates on the values it produces.
- Sidecar replay ([ADR-0007](./0007-forward-replay-state-derivation.md)) composes cleanly: each prior migration's Op list is applied to a fresh `State`, with no need to reconstruct a `Guarddog` from history.
- Tests over the lifecycle don't need a `Guarddog` fixture — they construct `State` and `Op[]` values directly.
- The CLI's `planMigrate` can return a typed `MigratePlan` (current state, previous state, forward Op list, rendered SQL) instead of being tangled with a `Guarddog` reference.
- Pure functions are easier to reason about for future refactors (parallel emit paths, alternate emitter targets).

**Negative**

- Newcomers expecting an OOP-style API (`guard.migrate()`) hit a slight learning curve. Mitigated by docs (this ADR, [PLAN.md](../PLAN.md), [ARCHITECTURE.md](../ARCHITECTURE.md)) and by the schema-file flow ([ADR-0018](./0018-schema-file-as-primary-interface.md)) being the primary user-facing surface — most consumers never call lifecycle functions directly.
- Some plumbing duplication: `planMigrate` must orchestrate `compileToState` + sidecar replay + `diffStates` + render, which is slightly more verbose than `guard.migrate(...)` would have been. Worth the trade for the testability + separation gains.

## Alternatives considered

- **Instance methods on `Guarddog`.** The original framing. Lost because (a) the same `Guarddog` can produce multiple states (overrides), (b) sidecar replay doesn't map naturally to a `Guarddog` instance, and (c) state-bearing methods invite implicit memoization bugs.
- **A separate stateful `Pipeline` class** wrapping `Guarddog` (`new Pipeline(guard).migrate(...)`). Marginally better than option 1 but still introduces a class that mostly exists to namespace functions. Pure functions are simpler.
- **Method chaining on `Guarddog` that returns a new builder** (`guard.toState().diff(prev)`). Reads well in TypeScript but obscures the fact that `State` is a plain data value — and chained methods couple `Guarddog`-the-class to lifecycle concerns we want to keep separate.

## References

- [ADR-0006 — Sidecar migration metadata](./0006-sidecar-migration-metadata.md)
- [ADR-0007 — Forward-replay state derivation](./0007-forward-replay-state-derivation.md)
- [ADR-0018 — Schema file as primary interface](./0018-schema-file-as-primary-interface.md)
- [`packages/core/src/lifecycle.ts`](../../packages/core/src/lifecycle.ts) — the functional API
- [`packages/core/src/ops.ts`](../../packages/core/src/ops.ts) — the `Op` union and `State` type
- [`packages/cli/src/commands/migrate.ts`](../../packages/cli/src/commands/migrate.ts) — `planMigrate` / `runMigrate` composing the functional API with file I/O
