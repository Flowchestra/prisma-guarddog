# 0011 — Extractable core with Flowchestra preset

**Status:** Accepted
**Date:** 2026-05-23

## Context

Guarddog originated as a Flowchestra-internal need. The threat model, role hierarchy (`app_user`/`app_system`), claim shape (WorkOS JWT), and `app.*` function calls are all Flowchestra-specific. Two architectural extremes:

- **Hard-bake Flowchestra in.** Fastest path to Phase 1. Locks the package into Flowchestra. Cannot be open-sourced as-is. Every other project would have to fork.
- **Build an OSS-quality generic abstraction on day 1.** Slower; risks abstraction-first design where the public API is shaped by hypothetical consumers rather than the one real consumer (Flowchestra). Six-month side quest with no shipped value.

## Decision

Build an **extractable core** with a **Flowchestra preset**:

- The core (`@prisma-guarddog/core`) is generic. It does not import or reference Flowchestra-specific names. Roles, claim shape, function-call hooks, and `resources` topology are inputs, not built-ins.
- A separate package (`@prisma-guarddog/preset-flowchestra`) carries the Flowchestra-specific defaults: WorkOS claim shape, role inheritance, `app.*` function bindings, conventional resource tree. Exposes `createFlowchestraGuarddog({ prisma, claimsAccessor })`.

Internal-first authoring; not OSS-grade ergonomics on day 1. The preset proves the public API is sufficient — if Flowchestra's claim graph cannot be expressed through public APIs, the public APIs are wrong.

```ts
// Flowchestra consumer:
import { createFlowchestraGuarddog } from '@prisma-guarddog/preset-flowchestra';
import { Prisma } from '@/generated/prisma';

const guard = createFlowchestraGuarddog({
  prisma: Prisma,
  claimsAccessor: 'request.jwt.claims',
});
```

```ts
// Non-Flowchestra consumer:
import { Guarddog, defineClaims, defineDbRoles } from '@prisma-guarddog/core';

const guard = new Guarddog({
  claims:  defineClaims({ ... }),
  dbRoles: defineDbRoles({ ... }),
  // ...
});
```

When Flowchestra goes private fork, the preset moves to that fork. The OSS preset becomes a generic-but-realistic example (renamed, retargeted at a sample app).

## Consequences

**Positive:**

- Phase 1 speed is preserved — the preset can be opinionated and Flowchestra-shaped.
- Public API is exercised end-to-end by the preset. If a preset needs to reach inside core internals, that's a signal the public API has a gap.
- OSS-ability is preserved without paying the abstraction cost up front.

**Negative:**

- Two packages to maintain instead of one.
- Risk that future presets (e.g., a generic Supabase Auth preset) reveal deficiencies in the core API. Acceptable risk — better to discover this through real preset implementations than through speculation.

## Alternatives considered

- **Single package with Flowchestra-specific bits hard-baked:** rejected — locks out OSS distribution and makes every non-Flowchestra user a forker.
- **Build the core as a fully generic OSS library before Phase 1:** rejected — premature abstraction; the API would be shaped by speculation rather than one real consumer.

## References

- [ADR-0016 — Turborepo monorepo](./0016-turborepo-monorepo.md)
