/**
 * `defineResourceGrants` — declare the resource-grant layer (layer 3 of the
 * three permission layers). A resource grant is a principal × action ×
 * resource record. Authoring this primitive lets policy predicates check
 * "does the user have permission to do `<action>` on `<resource>`?" via
 * `p.hasGrant(action, col(...))`.
 *
 * The `actions` vocabulary is declared here so `hasGrant('edit', col(...))`
 * type-checks at the call site against the declared set — same idea as
 * `defineAppRoles` for role strings.
 *
 * Phase 1: only `source: 'claims'`. The grants are encoded in the session
 * claims as a jsonb object keyed by action name -> array of resource IDs:
 *
 *     // claims payload
 *     {
 *       "grants": {
 *         "edit":   ["ws-1", "ws-2"],
 *         "delete": ["ws-1"],
 *         "admin":  ["ws-1"]
 *       }
 *     }
 *
 * Phase 2+ will add `source: 'table'` for a guarddog-emitted grants table
 * backed by Postgres rows instead of claim payload. The emitter contract
 * will be the same; only the SQL produced for `hasGrant(...)` changes.
 */

export type ResourceGrantsSource = 'claims'

export interface ResourceGrantsDefinition<TActions extends string = string> {
  readonly source: ResourceGrantsSource
  readonly claimPath: string
  readonly actions: ReadonlyArray<TActions>
}

export function defineResourceGrants<const TActions extends string>(config: {
  source?: ResourceGrantsSource
  claimPath?: string
  actions: ReadonlyArray<TActions>
}): ResourceGrantsDefinition<TActions> {
  if (config.actions.length === 0) {
    throw new Error(
      '[prisma-guarddog] defineResourceGrants: actions must be a non-empty array. ' +
        "The action vocabulary is what enables type-checked p.hasGrant('action', col) calls."
    )
  }
  const seen = new Set<string>()
  for (const action of config.actions) {
    if (action.length === 0) {
      throw new Error('[prisma-guarddog] defineResourceGrants: action names must be non-empty strings.')
    }
    if (seen.has(action)) {
      throw new Error(
        `[prisma-guarddog] defineResourceGrants: duplicate action "${action}" in actions[]. Each action must be unique.`
      )
    }
    seen.add(action)
  }
  const claimPath = config.claimPath ?? 'grants'
  if (claimPath.length === 0) {
    throw new Error('[prisma-guarddog] defineResourceGrants: claimPath must be a non-empty string (default: "grants").')
  }
  return Object.freeze({
    source: config.source ?? 'claims',
    claimPath,
    actions: Object.freeze([...config.actions]) as ReadonlyArray<TActions>,
  })
}
