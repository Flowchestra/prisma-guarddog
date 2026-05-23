# 0012 — Scaffold-only importer

**Status:** Accepted
**Date:** 2026-05-23

## Context

A real consumer of guarddog (Flowchestra is the canary) already has hand-written RLS across hundreds of tables. Migrating that into guarddog has two possible shapes:

- **Reverse-engineering importer:** read `pg_policies` and the column-privilege catalog, parse the SQL, infer the corresponding TypeScript policy definitions automatically.
- **Scaffold-only importer:** read the same catalogs, emit TypeScript stubs that wrap the existing SQL as `rawSql()` blocks plus `.todo()` markers, and mark uncovered models with `noPolicy({ reason: 'imported as missing policy; confirm manually' })`. Hand-tune from there.

The first option is appealing but dishonest. SQL is evidence, not gospel. A `current_setting('tenant_id') = tenant_id` clause is unambiguous; a polymorphic-table policy that joins through `ScopeTarget` and references three columns by hand-rolled aliases is not. Reverse-engineering business intent from SQL produces a confident-looking but subtly wrong codebase. The failure mode is worse than not importing at all.

## Decision

The importer operates in **scaffold mode only**. It produces TypeScript files that compile and pass lint, but it never claims to express the policy's business intent in the typed DSL. Every imported policy lands as `rawSql()` + `.todo()`:

```ts
guard.model(Prisma.ModelName.Workbench)
  .rawSql('select', `
    -- imported from pg_policies on 2026-05-23
    -- source: workbenches_select_v3
    (tenant_id = (current_setting('request.jwt.claims', true)::json ->> 'tenantId')::uuid)
      AND (workspace_id = ANY(...))
  `)
  .todo('Replace raw SQL with typed predicates');
```

Tables present in the Prisma schema but absent from the policy catalog become:

```ts
guard.noPolicy(Prisma.ModelName.SomeTable, {
  reason: 'Imported as missing policy; confirm manually',
});
```

The importer is **one-shot**, not bidirectional. Re-running it does not refresh previously-imported files — re-running would clobber hand-tuned policies. Re-imports require explicit deletion of the prior scaffold.

## Consequences

**Positive:**

- Day-one coverage of an existing 100+ table schema without lying about correctness.
- Lint coverage is satisfied (every model has `policy()`, `noPolicy()`, or `importedRawPolicy()`).
- Migration diffability begins immediately — guarddog can emit new policies alongside the raw-SQL-wrapped existing ones.
- Hand-tuning is explicit: when a TODO is resolved, the diff shows raw SQL → typed predicates as a real review.

**Negative:**

- Imported policies are opaque to the type system until manually rewritten. Type-checking gains are deferred per-table.
- The `rawSql()` escape hatch becomes load-bearing during the migration period — it must support every Postgres construct that hand-rolled policies might use.

## Alternatives considered

- **Reverse-engineering importer:** rejected — produces confident-looking output that silently reshapes intent. The most dangerous kind of automation.
- **No importer; require hand-rewriting every policy before adoption:** rejected — 100+ tables makes this practically impossible. Adoption never happens.
- **Bidirectional importer that updates existing scaffolds:** rejected — destroys hand-tuned policies. Re-import is destructive and must be explicit.

## References

- [ADR-0014 — Phase scope boundaries](./0014-phase-scope-boundaries.md)
