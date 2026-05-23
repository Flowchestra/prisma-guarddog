# Documentation

## Start here

- **[PLAN.md](./PLAN.md)** — phased roadmap, Phase 1 milestones, definition-of-done, non-goals
- **[GLOSSARY.md](./GLOSSARY.md)** — vocabulary (the four-primitive split, terminology discipline)

## Decision records

All foundational decisions are captured as ADRs in [`adr/`](./adr/). Read [`adr/README.md`](./adr/README.md) for the ADR process and lifecycle.

The Phase 1 set:

| #    | Decision                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------- |
| 0001 | [Policy compiler, not runtime middleware](./adr/0001-policy-compiler-not-runtime-middleware.md)             |
| 0002 | [Evaluated and rejected alternatives](./adr/0002-evaluated-and-rejected-alternatives.md)                    |
| 0003 | [Four-primitive split](./adr/0003-four-primitive-split.md)                                                  |
| 0004 | [Column privileges vs row-conditional masking](./adr/0004-column-privileges-vs-row-conditional-masking.md)  |
| 0005 | [Explicit USING and WITH CHECK](./adr/0005-explicit-using-and-with-check.md)                                |
| 0006 | [Sidecar migration metadata](./adr/0006-sidecar-migration-metadata.md)                                      |
| 0007 | [Forward-replay state derivation](./adr/0007-forward-replay-state-derivation.md)                            |
| 0008 | [Idempotent DDL emission](./adr/0008-idempotent-ddl-emission.md)                                            |
| 0009 | [Config resolution order](./adr/0009-config-resolution-order.md)                                            |
| 0010 | [Migrations colocate with Prisma](./adr/0010-migrations-colocate-with-prisma.md)                            |
| 0011 | [Extractable core with Flowchestra preset](./adr/0011-extractable-core-with-flowchestra-preset.md)          |
| 0012 | [Scaffold-only importer](./adr/0012-scaffold-only-importer.md)                                              |
| 0013 | [Real Postgres required for tests](./adr/0013-real-postgres-required-for-tests.md)                          |
| 0014 | [Phase scope boundaries](./adr/0014-phase-scope-boundaries.md)                                              |
| 0015 | [TypeScript as the DSL](./adr/0015-typescript-as-dsl.md)                                                    |
| 0016 | [Turborepo monorepo](./adr/0016-turborepo-monorepo.md)                                                      |
| 0017 | [TypeScript implementation; no compiled binary](./adr/0017-typescript-implementation.md)                    |
| 0018 | [Schema file as the primary interface](./adr/0018-schema-file-as-primary-interface.md)                      |
<!-- markdownlint-disable-next-line MD060 -->
| 0019 | [Three permission layers + per-resource jsonb permissions](./adr/0019-three-permission-layers-and-resource-permissions.md) |

## To be added

These will be drafted during implementation as decisions land:

- `architecture/overview.md` — high-level diagram of how core / emitters / importers / testing / CLI interact
- `architecture/emitters.md` — emitter contract, AST shape, dialect targeting
- `architecture/importer.md` — scaffold-mode contract, output shape, idempotent re-runs
- `architecture/testing.md` — verification harness design, transaction isolation per test
- `api/core.md` — `Guarddog` API reference
- `api/extensions.md` — `.use()` extension model
- `examples/` — annotated walkthroughs for the 5 proof-of-API tables
