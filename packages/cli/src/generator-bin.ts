#!/usr/bin/env node
/**
 * `prisma-guarddog-generator` — the binary Prisma invokes when the user
 * has a `generator guarddog { ... }` block in their `schema.prisma`.
 *
 * Prisma speaks the generator JSON-RPC protocol over stdin/stdout;
 * `@prisma/generator-helper.generatorHandler` wraps that protocol so we
 * only have to implement two hooks:
 *
 *   onManifest   announce the generator name + default output path.
 *   onGenerate   receive the DMMF + invoke our codegen.
 *
 * The actual codegen logic lives in `@prisma-guarddog/importer-prisma`'s
 * `runGuarddogGenerator` — same routine the upcoming `prisma-guarddog
 * generate` subcommand will reuse for direct CLI invocation.
 *
 * Wiring in the consumer's schema.prisma:
 *
 *   generator guarddog {
 *     provider = "prisma-guarddog-generator"
 *     output   = "./generated/guarddog-models.ts"
 *   }
 *
 * Then `prisma generate` regenerates the model types alongside Prisma's
 * own client.
 */

import { runGuarddogGenerator } from '@prisma-guarddog/importer-prisma'
import { generatorHandler } from '@prisma/generator-helper'

generatorHandler({
  onManifest: () => ({
    version: '0.0.0',
    defaultOutput: 'generated/guarddog-models.ts',
    prettyName: 'prisma-guarddog',
  }),
  onGenerate: async (options) => {
    await runGuarddogGenerator(options)
  },
})
