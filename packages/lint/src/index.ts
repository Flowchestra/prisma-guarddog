/**
 * `@prisma-guarddog/lint` — coverage check.
 *
 * Phase 1 surface (implementation pending):
 *   - Cross-references Prisma DMMF model list against guarddog registry
 *   - Fails if any model lacks `policy()`, `noPolicy()`, or `importedRawPolicy()`
 *   - Exposes both a programmatic API and a CLI subcommand surface
 *
 * Catches "I added a Prisma model and forgot to write a policy" — which is the
 * exact class of bug RLS can't help with if the model has no policy at all.
 */

export {};
