/**
 * `defineClaims` — declare the shape of the JWT (or session) claims that
 * guarddog policies will reference.
 *
 * The shape function receives a builder (`c`) and returns a record of typed
 * fields. Each field carries enough metadata for:
 *   - TS-level inference (consumers get a typed `claims.X` API in predicates)
 *   - SQL emission (the emitter knows how to extract + cast each field)
 *
 * Example:
 *
 *     const claims = defineClaims({
 *       accessor: 'request.jwt.claims',
 *       shape: c => ({
 *         sub:           c.uuid(),
 *         tenantId:      c.uuid(),
 *         workspaceIds:  c.array(c.uuid()),
 *         workbenchId:   c.optional(c.uuid()),
 *         roles:         c.array(c.string()),
 *       }),
 *     });
 *
 *     // Inferred shape:
 *     // { sub: string; tenantId: string; workspaceIds: string[];
 *     //   workbenchId: string | null; roles: string[]; }
 */

export type ClaimKind = 'string' | 'uuid' | 'integer' | 'boolean'

/**
 * A single typed claim field. The `_type` member is a phantom — it carries the
 * TS type for inference but is `undefined` at runtime.
 */
export interface ClaimField<out T> {
  readonly _type: T
  readonly kind: ClaimKind
  readonly isArray: boolean
  readonly isNullable: boolean
}

export interface ClaimBuilder {
  string: () => ClaimField<string>
  uuid: () => ClaimField<string>
  integer: () => ClaimField<number>
  boolean: () => ClaimField<boolean>
  array: <T>(inner: ClaimField<T>) => ClaimField<T[]>
  optional: <T>(inner: ClaimField<T>) => ClaimField<T | null>
}

export interface ClaimsShape {
  readonly [key: string]: ClaimField<unknown>
}

export interface ClaimsDefinition<S extends ClaimsShape = ClaimsShape> {
  readonly accessor: string
  readonly shape: S
}

/**
 * Helper to extract the JS-level claim shape from a `ClaimsDefinition`.
 *
 *     type Claims = InferClaims<typeof claims>
 *     // -> { sub: string; tenantId: string; ... }
 */
export type InferClaims<D> =
  D extends ClaimsDefinition<infer S>
    ? { -readonly [K in keyof S]: S[K] extends ClaimField<infer T> ? T : never }
    : never

function makeField<T>(kind: ClaimKind, isArray: boolean, isNullable: boolean): ClaimField<T> {
  return Object.freeze({
    _type: undefined as unknown as T,
    kind,
    isArray,
    isNullable,
  })
}

function makeBuilder(): ClaimBuilder {
  return {
    string: () => makeField<string>('string', false, false),
    uuid: () => makeField<string>('uuid', false, false),
    integer: () => makeField<number>('integer', false, false),
    boolean: () => makeField<boolean>('boolean', false, false),
    array: <T>(inner: ClaimField<T>): ClaimField<T[]> =>
      Object.freeze({
        _type: undefined as unknown as T[],
        kind: inner.kind,
        isArray: true,
        isNullable: false,
      }),
    optional: <T>(inner: ClaimField<T>): ClaimField<T | null> =>
      Object.freeze({
        _type: undefined as unknown as T | null,
        kind: inner.kind,
        isArray: inner.isArray,
        isNullable: true,
      }),
  }
}

export function defineClaims<S extends ClaimsShape>(config: {
  accessor: string
  shape: (c: ClaimBuilder) => S
}): ClaimsDefinition<S> {
  if (config.accessor.length === 0) {
    throw new Error('[prisma-guarddog] defineClaims: accessor must be a non-empty string.')
  }
  const builder = makeBuilder()
  const shape = config.shape(builder)
  return Object.freeze({
    accessor: config.accessor,
    shape: Object.freeze({ ...shape }) as S,
  })
}
