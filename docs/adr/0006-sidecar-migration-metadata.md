# 0006 — Sidecar migration metadata

**Status:** Accepted
**Date:** 2026-05-23

## Context

To compute the next migration, guarddog needs to know what policies and grants are currently deployed. Two main strategies for tracking this:

- **Central manifest file:** one file (e.g., `prisma/guarddog-manifest.json`) that records the current deployed state. Updated on every `guarddog migrate`.
- **Per-migration sidecars:** colocate a small metadata file with each generated `migration.sql`. Current state is derived by forward-replay.

A central manifest is simpler to query but introduces a parallel state surface that can drift from the migrations directory — for instance, when migrations are reverted manually, or when two PRs land out of order. A drifted manifest produces incorrect diffs.

Per-migration sidecars travel with the migration: a PR that adds a migration also adds its sidecar; a revert removes both. The migration history is the source of truth.

## Decision

Each generated migration ships with a `guarddog.json` sidecar colocated in the same directory:

```
prisma/migrations/
  20260523120000_init_workbench_policies/
    migration.sql              ← Prisma reads this normally
    guarddog.json              ← sidecar: operations log for this migration
  20260524093000_add_file_polymorphic/
    migration.sql
    guarddog.json
```

There is no central manifest. There is no snapshot of "current state" stored anywhere. State is always derived (see [ADR-0007](./0007-forward-replay-state-derivation.md)).

The sidecar format is an operations log, not a state snapshot:

```json
{
  "version": 1,
  "ops": [
    { "op": "enable-rls",   "table": "public.workbenches" },
    { "op": "force-rls",    "table": "public.workbenches" },
    { "op": "create-policy", "table": "public.workbenches", "name": "workbench_select",
      "for": "SELECT", "to": ["app_user"], "using": "...", "withCheck": null },
    { "op": "grant-column", "table": "public.workbenches", "column": "api_key",
      "privilege": "SELECT", "to": ["app_system"] }
  ]
}
```

## Consequences

**Positive:**

- PR diff shows `migration.sql` + `guarddog.json` together. Atomic.
- Revert a migration → remove its directory → its policies disappear from state automatically.
- Foreign migrations (Prisma-only, no guarddog content) are transparently handled — no sidecar, no contribution to guarddog state.
- No drift surface. The migration directory is the only source of truth.

**Negative:**

- Slightly more files in `prisma/migrations/`.
- Diff computation requires walking the migration directory each time (cheap; bounded by migration count).

## Alternatives considered

- **Central manifest file:** rejected — drift surface; conflicts between manifest and migration history are real and recurrent in any team's workflow.
- **State snapshot per migration:** rejected — saves replay cost but reintroduces the "snapshot of state" model that conflates schema state with policy state. See [ADR-0007](./0007-forward-replay-state-derivation.md).
- **Embed metadata as SQL comments inside `migration.sql`:** rejected — parsing SQL comments is brittle; separate JSON file is structured and tooling-friendly.

## References

- [ADR-0007 — Forward-replay state derivation](./0007-forward-replay-state-derivation.md)
- [ADR-0008 — Idempotent DDL emission](./0008-idempotent-ddl-emission.md)
- [ADR-0010 — Migrations colocate with Prisma](./0010-migrations-colocate-with-prisma.md)
