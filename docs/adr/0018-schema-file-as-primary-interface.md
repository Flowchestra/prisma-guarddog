# 0018 — Schema file as the primary interface

**Status:** Accepted
**Date:** 2026-05-23

## Context

ADR-0015 locked TypeScript as the DSL. The thinking was sound — reuse TS
tooling, get refactor support and type-checking for free — but the realization
landed as an imperative `new Guarddog({...})` construction plus chained
`.model().policy()` calls. That works mechanically, but it positions
`prisma-guarddog` as a *library you call*, not a *schema you declare*.

The intended value of this package is closer to Prisma's own positioning:

- A user has `prisma/schema.prisma` declaring their data model.
- They edit it; their IDE / LSP / linter helps with autocomplete and
  validation against that schema.
- They run `prisma generate` and `prisma migrate dev`; idempotent SQL
  migrations land on disk.

For `prisma-guarddog`, the analogous flow is:

- A user has `prisma/guarddog.ts` (or equivalent) declaring their
  permissions model + policies.
- They edit it; their IDE autocompletes role names, grant names, action
  names, and model names that come from this schema and the adjacent
  `schema.prisma`.
- They run a guarddog CLI command (or Prisma-generator hook) and idempotent
  SQL migrations land on disk alongside Prisma's.

The imperative `new Guarddog({...})` API is the *runtime* representation
of the schema — it is **not** the primary surface. The primary surface is
a declarative schema file.

## Decision

The primary user-facing interface of `prisma-guarddog` is a **schema file**:

- **Convention:** `prisma/guarddog.ts` (sibling to `schema.prisma`).
- **Entry point:** the file `export default`s a value produced by
  `defineSchema({...})`.
- **Shape:** `defineSchema` consolidates `claims`, `dbRoles`, `appRoles`,
  `resourceGrants`, `resources`, and a `policies(guard)` callback into a
  single declarative value.

```ts
// prisma/guarddog.ts
import { defineSchema } from 'prisma-guarddog'
import { Prisma } from '@prisma/client'

export default defineSchema({
  claims: { /* defineClaims output */ },
  dbRoles: { /* defineDbRoles output */ },
  appRoles: { /* defineAppRoles output */ },
  resourceGrants: { /* defineResourceGrants output */ },
  resources: { /* defineResources output */ },

  policies(guard) {
    guard.model(Prisma.ModelName.Workbench)
      .policy('app_user')
      .select(p => /* ... */)
    // ...
  },
})
```

The `Guarddog` class, `ModelBuilder`, `PolicyBuilder`, etc. — everything
shipped in commits f82c253, 83222ae, 9ead214 — become the **runtime** the
CLI uses to evaluate the schema. The schema file declares; the runtime
materializes. Consumers should rarely instantiate `Guarddog` directly.

## CLI surface

The CLI auto-discovers `prisma/guarddog.ts` (and honors overrides via
`guarddog.config.ts` per ADR-0009). Commands:

```
prisma-guarddog generate   # type-checks the schema; produces autocomplete
                           # types (DMMF-bridged model + role/grant unions)
prisma-guarddog migrate    # generates an idempotent migration + sidecar
                           # into prisma/migrations/<ts>_<name>/
prisma-guarddog check      # CI-time validation: schema parses, policies
                           # cover every Prisma model, lint clean
```

## Prisma integration

Two integration points:

1. **Direct CLI invocation** as shown above. Consumers add it to their
   `package.json` scripts (`"db:migrate": "prisma migrate dev && prisma-guarddog migrate"`).
2. **Prisma generator block** — when `prisma generate` runs, our generator
   refreshes the DMMF-derived autocomplete types and validates the
   schema. This is the same mechanism `prisma-erd-generator` and similar
   use.

```prisma
// schema.prisma
generator guarddog {
  provider = "prisma-guarddog"
}
```

The generator implementation lives in the `@flowchestra/prisma-guarddog-importer-prisma`
package (it owns the DMMF integration anyway).

## IDE / LSP integration

The vast majority of "autocomplete role names, grant names, model names"
falls out of TypeScript's existing LSP because:

- `defineDbRoles({ app_user: {...} })` returns a typed value; downstream
  references narrow to the registered keys.
- The DMMF-bridged `Models` enum produced by `prisma-guarddog generate`
  gives the user a typed handle for model names (so `Prisma.ModelName.X`
  references in policies are autocompleted to actual Prisma models).
- Action vocabularies declared in `defineResourceGrants` produce string
  literal types that autocomplete in `p.hasGrant('...')` calls.

What we add on top:

- A `@flowchestra/prisma-guarddog-lint` rule that fires on Prisma models not covered
  by a `policy()` / `noPolicy()` / `importedRawPolicy()` declaration
  (already planned).
- Generated `.d.ts` artifacts that bridge Prisma's DMMF into our
  type-level vocabulary so `Prisma.ModelName.X` always reflects the
  current `schema.prisma`.

## Consequences

**Positive:**

- Mental model matches Prisma's: schema file + generator + migrations.
- Authoring is declarative; the runtime is invisible to the consumer in
  the common case.
- IDE intelligence rides existing TS tooling — no language server to
  ship or maintain.
- The CLI / generator boundary is well-known territory (every Prisma
  ecosystem tool works the same way).

**Negative:**

- All examples in `docs/` written against the imperative API need to be
  rewritten in terms of the schema file.
- The `Guarddog` class becomes a *less prominent* part of the public
  API; we should not break it (extension authors and the testing
  harness rely on it), but we should de-emphasize it.
- A consumer with multiple deployment environments may want to split
  the schema across files. We need to support imports cleanly (TS
  re-exports / module composition).

## Alternatives considered

- **Stay imperative-first.** Rejected — value-prop misalignment per the
  context above.
- **Build a separate DSL with its own grammar (Prisma-style).** Rejected
  per ADR-0015 — TypeScript is the DSL. We layer a declarative
  convention *on top of* TypeScript, not a parallel parser.
- **Make `Guarddog` itself the schema** (i.e., `export default new
  Guarddog({...})`). Rejected — the schema needs to be evaluable before
  policies are attached (so the CLI can validate roles/grants before
  walking the policy callback), which a `Guarddog` instance doesn't
  cleanly express.

## References

- [ADR-0009 — Config resolution order](./0009-config-resolution-order.md)
- [ADR-0014 — Phase scope boundaries](./0014-phase-scope-boundaries.md)
- [ADR-0015 — TypeScript as the DSL](./0015-typescript-as-dsl.md)
