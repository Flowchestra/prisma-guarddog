#!/usr/bin/env node
/**
 * `prisma-guarddog` CLI entrypoint. Routes subcommands via commander.
 *
 * Currently:
 *   guarddog check     — validate the schema file loads + materializes
 *
 * Coming soon (depends on the .emit/.diff/.migrate lifecycle):
 *   guarddog generate  — emit DMMF-bridged autocomplete types
 *   guarddog migrate   — produce a timestamped migration + sidecar
 *   guarddog import    — scaffold-mode import from a live database
 */

import { Command } from 'commander'
import pc from 'picocolors'

import { runCheck } from './commands/check.js'
import { discoverConfig } from './config.js'

async function main(): Promise<void> {
  const program = new Command()
  program
    .name('guarddog')
    .description('Schema-driven policy compiler for Prisma-backed Postgres applications.')
    .version('0.0.0')

  program
    .command('check')
    .description('Validate the schema file loads, materializes, and yields a Guarddog instance.')
    .option('--cwd <path>', 'override the working directory used for config discovery')
    .action(async (opts: { cwd?: string }) => {
      const config = await discoverConfig(opts.cwd ?? process.cwd())
      const result = await runCheck({ config })
      process.exit(result.ok ? 0 : 1)
    })

  try {
    await program.parseAsync(process.argv)
  } catch (err) {
    process.stderr.write(`${pc.red('error:')} ${(err as Error).message}\n`)
    process.exit(1)
  }
}

await main()
