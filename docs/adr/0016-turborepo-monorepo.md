# 0016 — Turborepo monorepo

**Status:** Accepted
**Date:** 2026-05-23

## Context

The Phase 1 scope already spans several distinct concerns that would otherwise be bundled into one package:

- Core type primitives and orchestration
- Postgres RLS emitter
- Postgres column-privileges emitter
- Prisma DMMF importer
- Postgres scaffold importer
- Real-Postgres testing harness
- Lint extension
- Flowchestra preset
- CLI

Phase 2+ adds provider-specific packages (Supabase importer, FDW emitter), and Phase 3 adds the WorkOS FGA bridge. A single published `prisma-guarddog` package would force every consumer to install Supabase, WorkOS, and FDW dependencies they don't use.

## Decision

Use a **Turborepo monorepo** from day 1. Each concern is a separately-published package under the `@prisma-guarddog/*` scope. The unscoped `prisma-guarddog` package is the user-facing CLI; it depends on `@prisma-guarddog/core` and the default emitters / importers.

```
prisma-guarddog/
  turbo.json
  pnpm-workspace.yaml
  tsconfig.base.json
  package.json                                ← root devDeps + scripts only
  docs/
  packages/
    core/                                     ← @prisma-guarddog/core
    emitter-postgres-rls/
    emitter-postgres-column-privileges/
    importer-prisma/
    importer-postgres/
    testing-postgres/
    lint/
    preset-flowchestra/
    cli/                                      ← prisma-guarddog (unscoped binary)
  examples/
    flowchestra-style/
```

Phase 2+ packages slot in alongside without disturbing Phase 1 packages:

```
  packages/
    importer-supabase/       ← Phase 2
    emitter-fdw/             ← Phase 2
    fga-workos/              ← Phase 3
```

Internal cross-package dependencies use `workspace:*`. Published packages are independently semver'd.

## Consequences

**Positive:**

- Consumers install only what they use. Supabase users get the Supabase importer; non-Supabase users don't.
- Independent semver per package — a breaking change to the FGA bridge doesn't bump the core's major version.
- Per-package CI matrix becomes clean (separate build/test/lint per package).
- Adding Phase 2/3 packages is a directory addition, not a refactor.

**Negative:**

- More moving parts than a single-package repo. Setup cost is higher (turbo config, workspace config, per-package package.json).
- Cross-package refactoring requires touching multiple files.
- Publishing requires either Changesets (recommended) or a similar coordinated-release tool — ad-hoc `npm publish` per package doesn't scale.

## Alternatives considered

- **Single package with subpath exports** (`prisma-guarddog/emitter-postgres-rls`): rejected — forces installation of all transitive deps regardless of usage. Cannot independently version provider extensions. Cannot have a consumer use Phase 1 today without later being forced into Phase 2+ dependencies.
- **Single package with optionalPeerDependencies for provider deps:** rejected — npm's `optionalPeerDependencies` semantics are weak; resolution is brittle across pnpm/npm/yarn. The mechanism is also undiscoverable to consumers.
- **Multiple separate repos (one per package):** rejected — coordinating changes across packages (which happens constantly during Phase 1) becomes a pain. Turborepo gives the multi-package benefits without the multi-repo overhead.

## References

- [ADR-0011 — Extractable core with Flowchestra preset](./0011-extractable-core-with-flowchestra-preset.md)
- [ADR-0014 — Phase scope boundaries](./0014-phase-scope-boundaries.md)
