# 0015 — TypeScript as the DSL

**Status:** Accepted
**Date:** 2026-05-23

## Context

Most policy-as-code tools have a separate DSL: ZModel (ZenStack), HCL (Atlas), declarative SQL (Supabase), YAML (various FGA systems). A separate DSL means a parser, an IDE plugin, separate documentation, separate refactor tooling, and a context switch for authors.

The policies guarddog cares about have several requirements that are awkward in a separate DSL:

- Reference Prisma model field enums (`Prisma.WorkbenchScalarFieldEnum`) for compile-time correctness
- Compose predicates with `AND`/`OR`/`NOT`
- Express polymorphic grants with discriminator-narrowing
- Bind to a user-defined JWT claim shape with type-checked field access
- Allow refactoring tools (find-references, rename) to follow through to consuming code

TypeScript already does all of this. Reusing it removes the DSL-design problem entirely.

## Decision

Policies are authored in TypeScript. There is no `.zmodel`-style file, no HCL, no YAML, no policy compiler that emits TypeScript. The TS file is itself the policy definition:

```ts
import { Prisma } from '@/generated/prisma';
import { col } from '@prisma-guarddog/core';

guard.model(Prisma.ModelName.Workbench)
  .policy('app_user')
  .select(p => p.tenantId.eq(col('tenantId'))
              .and(p.workspaceMember(col('workspaceId'))))
  .insert({ check: p => p.hasRole('workspace.editor', col('workspaceId')) })
  // ...
```

Column references via `col()` are typed against `Prisma.<Model>ScalarFieldEnum` — passing a non-existent column name is a type error.

## Consequences

**Positive:**

- `tsgo` (the consumer's existing type-checker) is the policy type-checker. No separate tool.
- IDE features (autocompletion, find-references, rename, jump-to-definition) work out of the box.
- Refactoring a Prisma model field name is followed by policy authoring automatically.
- No DSL grammar to design, parse, or maintain.

**Negative:**

- Policies cannot be authored by non-TypeScript users (e.g., DBAs unfamiliar with TS). Mitigated: the `rawSql()` escape hatch lets DBAs write raw SQL fragments inside the TS scaffold; the importer accepts existing SQL.
- The compiled output (Postgres DDL) is not the source of truth. A DBA reading a migration sees the SQL but not the TS that generated it. Mitigated by sidecar metadata pointing back to the source.

## Alternatives considered

- **Separate DSL (ZModel-style):** rejected — every benefit (refactor tooling, type-checking, IDE support) requires reinventing what TS already provides.
- **YAML/JSON config:** rejected — predicate composition (`AND`/`OR`/`NOT`) and Prisma-typed column references are awkward in declarative data formats.
- **Decorators on Prisma models:** rejected — Prisma's schema language is not extensible, and forking Prisma is not an option.

## References

- [ADR-0002 — Evaluated and rejected alternatives](./0002-evaluated-and-rejected-alternatives.md)
- [ADR-0017 — TypeScript implementation; no compiled binary](./0017-typescript-implementation.md)
