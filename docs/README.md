# Documentation

## Start here

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — system overview, package map, end-to-end compile path. Read this first.
- **[PLAN.md](./PLAN.md)** — phased roadmap, Phase 1 status, non-goals.
- **[GLOSSARY.md](./GLOSSARY.md)** — vocabulary (three permission layers, scope cascade, terminology discipline).

## Per-package reference

Each package ships its own short README with install + usage + design pointers. Read the architecture overview first; the per-package docs assume you know how the pieces fit together.

<!-- markdownlint-disable MD060 -->

| Package | Purpose |
| --- | --- |
| [`@flowchestra/prisma-guarddog-core`](../packages/core/README.md) | DSL primitives, AST, Op union, compile + diff |
| [`@flowchestra/prisma-guarddog-emitter-postgres-rls`](../packages/emitter-postgres-rls/README.md) | `Expr` → SQL; `PolicyAst` → CREATE POLICY; role lifecycle |
| [`@flowchestra/prisma-guarddog-emitter-postgres-column-privileges`](../packages/emitter-postgres-column-privileges/README.md) | `ColumnPrivilegeAst` → GRANT/REVOKE |
| [`prisma-guarddog`](../packages/cli/README.md) (CLI) | `migrate`, `check`, generator binary, `renderOps`, sidecar I/O |
| [`@flowchestra/prisma-guarddog-importer-prisma`](../packages/importer-prisma/README.md) | Prisma DMMF readers + model-type codegen |
| [`@flowchestra/prisma-guarddog-importer-postgres`](../packages/importer-postgres/README.md) | `pg_policies` → scaffold (`rawSql()` + `.todo()`) |
| [`@flowchestra/prisma-guarddog-testing-postgres`](../packages/testing-postgres/README.md) | `withScenario` + assertion helpers (real-PG only) |
| [`@flowchestra/prisma-guarddog-lint`](../packages/lint/README.md) | Coverage check |
| [`@flowchestra/prisma-guarddog-preset`](../packages/preset-flowchestra/README.md) | Opinionated preset (reference for downstream presets) |

<!-- markdownlint-enable MD060 -->

## Examples

- [`examples/`](../examples/README.md) — working end-to-end examples with their own READMEs and tests.

## Decision records

All foundational decisions are captured as ADRs in [`adr/`](./adr/). Read [`adr/README.md`](./adr/README.md) for the ADR process and lifecycle.

### Positioning + scope

| #    | Decision                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------- |
| 0001 | [Policy compiler, not runtime middleware](./adr/0001-policy-compiler-not-runtime-middleware.md)             |
| 0002 | [Evaluated and rejected alternatives](./adr/0002-evaluated-and-rejected-alternatives.md)                    |
| 0014 | [Phase scope boundaries](./adr/0014-phase-scope-boundaries.md)                                              |
| 0015 | [TypeScript as the DSL](./adr/0015-typescript-as-dsl.md)                                                    |
| 0017 | [TypeScript implementation; no compiled binary](./adr/0017-typescript-implementation.md)                    |
| 0018 | [Schema file as the primary interface](./adr/0018-schema-file-as-primary-interface.md)                      |

### Modeling

| #    | Decision                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------- |
| 0003 | [Four-primitive split](./adr/0003-four-primitive-split.md) *(superseded by ADR-0019)*                       |
| 0004 | [Column privileges vs row-conditional masking](./adr/0004-column-privileges-vs-row-conditional-masking.md)  |
| 0005 | [Explicit USING and WITH CHECK](./adr/0005-explicit-using-and-with-check.md)                                |
<!-- markdownlint-disable-next-line MD060 -->
| 0019 | [Three permission layers + per-resource jsonb permissions](./adr/0019-three-permission-layers-and-resource-permissions.md) |
| 0021 | [Table-backed resource grants (source: 'table')](./adr/0021-table-backed-resource-grants.md)                 |
| 0022 | [Rank-based grant tables (roleColumn + roleHierarchy)](./adr/0022-rank-based-grant-tables.md)                |
| 0023 | [Grant principal disjunction (user OR group)](./adr/0023-grant-principal-disjunction.md)                     |
| 0025 | [hasGrant per-call table hint](./adr/0025-hasgrant-per-call-table-hint.md)                                   |
| 0026 | [guarddog-managed SQL functions (defineFunctions)](./adr/0026-managed-sql-functions.md)                      |
| 0027 | [Column-privilege enforcement gap: lint now, base-table later](./adr/0027-column-privilege-enforcement-gap.md) |
| 0028 | [Typed model + column references (model() / p.col() autocomplete)](./adr/0028-typed-model-and-column-references.md) |
| 0031 | [Opt-in user-declared policy names (.named() + per-verb { name })](./adr/0031-user-declared-policy-names.md)  |
| 0032 | [Restrictive policy support (.restrictivePolicy() + .isolation() sugar)](./adr/0032-restrictive-policy-support.md) |

### Migration + state

| #    | Decision                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------- |
| 0006 | [Sidecar migration metadata](./adr/0006-sidecar-migration-metadata.md)                                      |
| 0007 | [Forward-replay state derivation](./adr/0007-forward-replay-state-derivation.md)                            |
| 0008 | [Idempotent DDL emission](./adr/0008-idempotent-ddl-emission.md)                                            |
| 0010 | [Migrations colocate with Prisma](./adr/0010-migrations-colocate-with-prisma.md)                            |
| 0020 | [Functional lifecycle over an Op-union state](./adr/0020-functional-lifecycle-over-op-union.md)             |
| 0024 | [Config-threaded render overrides + ergonomics](./adr/0024-config-threaded-render-overrides.md)             |
| 0029 | [Handling existing (foreign) RLS policies](./adr/0029-handling-existing-rls-policies.md)                     |
| 0030 | [Interactive adoption triage (guarddog adopt)](./adr/0030-interactive-adoption-triage.md)                    |

### Repo + extension model

| #    | Decision                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------- |
| 0009 | [Config resolution order](./adr/0009-config-resolution-order.md)                                            |
| 0011 | [Extractable core with Flowchestra preset](./adr/0011-extractable-core-with-flowchestra-preset.md)          |
| 0012 | [Scaffold-only importer](./adr/0012-scaffold-only-importer.md)                                              |
| 0013 | [Real Postgres required for tests](./adr/0013-real-postgres-required-for-tests.md)                          |
| 0016 | [Turborepo monorepo](./adr/0016-turborepo-monorepo.md)                                                      |
