#!/usr/bin/env node
/**
 * `prisma-guarddog` CLI entrypoint. Routes subcommands via commander.
 *
 * Subcommands:
 *   guarddog check     — validate the schema file loads + materializes
 *                        (--lint also fails on missing-coverage models)
 *   guarddog migrate   — diff vs sidecars and write a new migration folder
 *   guarddog emit      — render full schema as SQL to stdout (or --out file)
 *   guarddog diff      — preview what the next migrate would emit, no writes
 *   guarddog import    — scaffold a guarddog.ts from a live database
 *   guarddog drift     — compare declared policies vs a live DB (ADR-0029)
 *   guarddog adopt     — interactively triage existing policies (ADR-0030)
 */

import { Command } from 'commander'
import pc from 'picocolors'

import pkg from '../package.json' with { type: 'json' }
import { runAdopt } from './commands/adopt.js'
import { runCheck } from './commands/check.js'
import { runDiff } from './commands/diff.js'
import { runDrift } from './commands/drift.js'
import { runEmit } from './commands/emit.js'
import { runImport } from './commands/import.js'
import { runMigrate } from './commands/migrate.js'
import { discoverConfig } from './config.js'

async function main(): Promise<void> {
  const program = new Command()
  program
    .name('guarddog')
    .description('Schema-driven policy compiler for Prisma-backed Postgres applications.')
    .version(pkg.version)

  program
    .command('check')
    .description('Validate the schema file loads, materializes, and yields a Guarddog instance.')
    .option('--cwd <path>', 'override the working directory used for config discovery')
    .option('--lint', 'also cross-reference Prisma models for missing-coverage (fails on gaps)')
    .action(async (opts: { cwd?: string; lint?: boolean }) => {
      const config = await discoverConfig(opts.cwd ?? process.cwd())
      const result = await runCheck({
        config,
        ...(opts.lint === true && { lint: true }),
      })
      process.exit(result.ok ? 0 : 1)
    })

  program
    .command('migrate')
    .description('Diff the schema against the existing sidecars and write a new timestamped migration.')
    .option('--cwd <path>', 'override the working directory used for config discovery')
    .option('--slug <slug>', 'override the migration folder slug (default: guarddog)')
    .option('--drop-unmanaged', 'drop foreign/legacy policies on managed tables (cutover; reads the live DB)')
    .option('--against <connection>', 'Postgres URL for --drop-unmanaged (falls back to GUARDDOG_DATABASE_URL)')
    .option('--schema <name>', 'Postgres schema to inspect for --drop-unmanaged (default: public)')
    .action(
      async (opts: { cwd?: string; slug?: string; dropUnmanaged?: boolean; against?: string; schema?: string }) => {
        const config = await discoverConfig(opts.cwd ?? process.cwd())
        const databaseUrl = opts.against ?? process.env['GUARDDOG_DATABASE_URL']
        const result = await runMigrate({
          config,
          ...(opts.slug !== undefined && { slug: opts.slug }),
          ...(opts.dropUnmanaged === true && { dropUnmanaged: true }),
          ...(databaseUrl !== undefined && { databaseUrl }),
          ...(opts.schema !== undefined && { schema: opts.schema }),
        })
        process.exit(result.ok ? 0 : 1)
      }
    )

  program
    .command('emit')
    .description('Render the full schema as SQL to stdout (or --out file). Read-only; touches no migrations.')
    .option('--cwd <path>', 'override the working directory used for config discovery')
    .option('--out <path>', 'write the SQL to this file instead of stdout')
    .action(async (opts: { cwd?: string; out?: string }) => {
      const config = await discoverConfig(opts.cwd ?? process.cwd())
      const result = await runEmit({
        config,
        ...(opts.out !== undefined && { out: opts.out }),
      })
      process.exit(result.ok ? 0 : 1)
    })

  program
    .command('diff')
    .description('Show what `guarddog migrate` would emit, without writing anything.')
    .option('--cwd <path>', 'override the working directory used for config discovery')
    .option('--exit-code', 'exit non-zero when there are pending changes (CI gate)')
    .action(async (opts: { cwd?: string; exitCode?: boolean }) => {
      const config = await discoverConfig(opts.cwd ?? process.cwd())
      const result = await runDiff({
        config,
        ...(opts.exitCode === true && { exitCode: true }),
      })
      process.exit(result.ok ? 0 : 1)
    })

  program
    .command('import')
    .description('Scaffold a guarddog.ts from an existing Postgres database. Output is rawSql() + .todo() stubs.')
    .requiredOption('--url <connection>', 'Postgres connection string (postgres://user:pass@host:port/db)')
    .option('--schema <name>', 'restrict to one Postgres schema (default: public)')
    .option('--out <path>', 'write the scaffold to this file instead of stdout')
    .action(async (opts: { url: string; schema?: string; out?: string }) => {
      const result = await runImport({
        url: opts.url,
        ...(opts.schema !== undefined && { schema: opts.schema }),
        ...(opts.out !== undefined && { out: opts.out }),
      })
      process.exit(result.ok ? 0 : 1)
    })

  program
    .command('drift')
    .description('Compare the schema’s declared policies against a live database and report drift (ADR-0029).')
    .option('--cwd <path>', 'override the working directory used for config discovery')
    .requiredOption('--against <connection>', 'Postgres connection string to compare against')
    .option('--schema <name>', 'restrict to one Postgres schema (default: public)')
    .option('--exit-code', 'exit non-zero when drift exists (CI gate)')
    .action(async (opts: { cwd?: string; against: string; schema?: string; exitCode?: boolean }) => {
      const config = await discoverConfig(opts.cwd ?? process.cwd())
      const result = await runDrift({
        config,
        url: opts.against,
        ...(opts.schema !== undefined && { schema: opts.schema }),
        ...(opts.exitCode === true && { exitCode: true }),
      })
      process.exit(result.ok ? 0 : 1)
    })

  program
    .command('adopt')
    .description('Interactively triage existing (foreign) RLS policies: keep / remove / edit / override (ADR-0030).')
    .option('--cwd <path>', 'override the working directory used for config discovery')
    .requiredOption('--against <connection>', 'Postgres connection string to triage against')
    .option('--schema <name>', 'restrict to one Postgres schema (default: public)')
    .option('--out <path>', 'write the edit/override scaffold to this file instead of stdout')
    .action(async (opts: { cwd?: string; against: string; schema?: string; out?: string }) => {
      const config = await discoverConfig(opts.cwd ?? process.cwd())
      const result = await runAdopt({
        config,
        url: opts.against,
        ...(opts.schema !== undefined && { schema: opts.schema }),
        ...(opts.out !== undefined && { out: opts.out }),
      })
      process.exit(result.ok ? 0 : 1)
    })

  try {
    await program.parseAsync(process.argv)
  } catch (err) {
    process.stderr.write(`${pc.red('error:')} ${(err as Error).message}\n`)
    process.exit(1)
  }
}

// Note: avoid top-level await — tsdown's CJS output doesn't support it.
// The `.catch()` here is defensive; `main()` itself catches inside, but
// any synchronous setup error in commander's `.parseAsync` chain would
// otherwise surface as an unhandled rejection.
main().catch((err: unknown) => {
  process.stderr.write(`${pc.red('error:')} ${(err as Error).message}\n`)
  process.exit(1)
})
