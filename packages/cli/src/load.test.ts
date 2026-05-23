import { defineAppRoles } from '@flowchestra/prisma-guarddog-core'
import { defineClaims } from '@flowchestra/prisma-guarddog-core'
import { defineDbRoles } from '@flowchestra/prisma-guarddog-core'
import { defineResources } from '@flowchestra/prisma-guarddog-core'
import { defineSchema } from '@flowchestra/prisma-guarddog-core'
import { describe, expect, it } from 'vitest'

import { loadSchema, materializeLoadedSchema, SchemaLoadError, validateSchemaModule } from './load.js'

/**
 * NOTE on test scope: the tests below cover the pure validation +
 * materialization helpers directly. The full end-to-end `loadSchema` path
 * (which goes through jiti to import a real TypeScript file from disk and
 * resolve `@flowchestra/prisma-guarddog-core` from the temp dir) requires the workspace
 * packages to be BUILT first — jiti delegates to Node's resolver for bare
 * imports, and Node won't load .ts targets named in package.json `exports`.
 * Once a `tsdown` build emits `dist/index.js` for each workspace package,
 * an end-to-end fixture test can land. For now we cover loadSchema only
 * for the no-jiti path (file-not-found error).
 */

// Return type intentionally inferred (NOT annotated as SchemaDefinition) so
// the narrow generics from defineSchema flow through. Annotating with the
// default-generics SchemaDefinition triggers a contravariance error on the
// policies(guard) slot under exactOptionalPropertyTypes.
function makeValidSchema() {
  return defineSchema({
    claims: defineClaims({ accessor: 'request.jwt.claims', shape: (c) => ({ sub: c.uuid() }) }),
    dbRoles: defineDbRoles({ app_user: { inherits: [] } }),
    appRoles: defineAppRoles({}),
    resources: defineResources({}),
    policies(guard) {
      guard
        .model('Foo')
        .policy('app_user')
        .select((p) => p.literal(true))
    },
  })
}

describe('validateSchemaModule (pure)', () => {
  it('unwraps the default-export envelope and returns the SchemaDefinition', () => {
    const schema = makeValidSchema()
    const mod = { default: schema }
    expect(validateSchemaModule(mod, '/tmp/x.ts')).toBe(schema)
  })

  it('accepts a bare SchemaDefinition (no default wrapper) — CJS interop case', () => {
    const schema = makeValidSchema()
    expect(validateSchemaModule(schema, '/tmp/x.ts')).toBe(schema)
  })

  it('throws SchemaLoadError when the module is null', () => {
    expect(() => validateSchemaModule(null, '/tmp/x.ts')).toThrow(SchemaLoadError)
  })

  it('throws SchemaLoadError when the module is a primitive', () => {
    expect(() => validateSchemaModule(42, '/tmp/x.ts')).toThrow(/did not export a SchemaDefinition/)
  })

  it('throws SchemaLoadError when the default export is not an object', () => {
    expect(() => validateSchemaModule({ default: 'not-a-schema' }, '/tmp/x.ts')).toThrow(
      /default export is not a SchemaDefinition/
    )
  })

  it('throws SchemaLoadError when policies is not a function', () => {
    expect(() => validateSchemaModule({ default: { policies: 'oops' } }, '/tmp/x.ts')).toThrow(
      /missing a `policies\(guard\)` callback/
    )
  })

  it('includes the schemaPath in the thrown error', () => {
    let caught: unknown
    try {
      validateSchemaModule(null, '/very/specific/path.ts')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SchemaLoadError)
    expect((caught as SchemaLoadError).schemaPath).toBe('/very/specific/path.ts')
  })
})

describe('materializeLoadedSchema (pure)', () => {
  it('returns a LoadedSchema with a working Guarddog when materialization succeeds', () => {
    const schema = makeValidSchema()
    const result = materializeLoadedSchema(schema, '/tmp/x.ts')
    expect(result.schemaPath).toBe('/tmp/x.ts')
    expect(result.schema).toBe(schema)
    expect(result.guard.getPolicies()).toHaveLength(1)
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('throws SchemaLoadError wrapping the underlying error on materialization failure', () => {
    // A schema whose policies callback throws inside materializeSchema —
    // materializeLoadedSchema must catch + wrap as SchemaLoadError.
    // Intentionally NOT annotated with `: SchemaDefinition` — annotating
    // with the default-generics type triggers a contravariance error vs.
    // the narrow generics defineSchema infers.
    const bad = defineSchema({
      claims: defineClaims({ accessor: 'x', shape: (c) => ({ sub: c.uuid() }) }),
      dbRoles: defineDbRoles({ app_user: { inherits: [] } }),
      appRoles: defineAppRoles({}),
      resources: defineResources({}),
      policies: () => {
        throw new Error('intentional policy authoring failure')
      },
    })
    // Capture the thrown error outside the catch so the expects don't
    // run conditionally (vitest/no-conditional-expect rule).
    let caught: unknown
    try {
      materializeLoadedSchema(bad, '/tmp/bad.ts')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SchemaLoadError)
    expect((caught as SchemaLoadError).message).toMatch(/failed to materialize/)
    expect((caught as SchemaLoadError).message).toMatch(/intentional policy authoring failure/)
    expect((caught as SchemaLoadError).cause).toBeDefined()
  })
})

describe('loadSchema (end-to-end, file-not-found path only)', () => {
  it('throws SchemaLoadError when the file does not exist', async () => {
    await expect(loadSchema('/nonexistent/path/to/guarddog.ts')).rejects.toBeInstanceOf(SchemaLoadError)
    await expect(loadSchema('/nonexistent/path/to/guarddog.ts')).rejects.toThrow(/schema file not found/)
  })

  // Full jiti-driven load tests are deferred until the workspace builds
  // emit `.js` exports targets. See file header for context.
})
