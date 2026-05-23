/**
 * `prisma-guarddog` (CLI) — programmatic entrypoint.
 *
 * The CLI is the user-facing orchestrator that ties core, emitters, and
 * importers together for filesystem I/O. The pure libraries do not touch the
 * filesystem; the CLI is where read/write happens.
 *
 * Phase 1 commands (implementation pending):
 *   - `guarddog emit`     — emit target DDL to stdout / dry-run check
 *   - `guarddog diff`     — diff target vs. forward-replayed sidecars
 *   - `guarddog migrate`  — write timestamped migration.sql + guarddog.json
 *                           sidecar into prisma/migrations/
 *   - `guarddog import`   — scaffold-mode importer from live Postgres
 */

export {};
