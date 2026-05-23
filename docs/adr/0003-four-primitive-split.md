# 0003 — Four-primitive split

**Status:** Accepted
**Date:** 2026-05-23

## Context

Casual conversation about authorization uses the word "hierarchy" for at least two distinct concepts:

- Postgres role inheritance (`CREATE ROLE app_system INHERIT IN ROLE app_user`)
- Resource-scope cascade (granting `workspace.admin` against workspace `W` implies admin on every workbench inside `W`)

These are not the same animal. Implementing them under a shared abstraction collapses two different evaluation paths into one and produces the kind of bug where a fix at one level silently changes behavior at another.

The same problem applies more broadly: it's tempting to treat "roles," "resources," and "grants" as one big graph. They aren't.

## Decision

Four primitives, modeled as four separate concepts in the API. They never share an abstraction, even when they share a word in conversation.

1. **`dbRoles`** — Postgres roles created via `CREATE ROLE`. Examples: `app_user`, `app_system`. dbRole inheritance is structural Postgres inheritance.
2. **`businessRoles`** — application-level roles expressed as strings in JWT claims. Examples: `workspace.admin`, `workbench.editor`, `org.viewer`. Evaluated by predicates, not by Postgres' role system.
3. **`resources`** — the resource tree (Tenant → Org → Workspace → Workbench). Defines which model corresponds to each level and how cascade works.
4. **`grants`** — principal/action/resource records. The output of attaching businessRoles to resources via predicates. Not stored by guarddog; evaluated by Postgres at query time.

These are declared via four separate API entry points:

```ts
new Guarddog({
  claims:        defineClaims({...}),
  dbRoles:       defineDbRoles({...}),
  businessRoles: defineBusinessRoles({...}),
});

guard.resources({...});
guard.model(Model).policy(dbRole).select(p => p.hasRole('workspace.admin', col('workspaceId')));
```

## Consequences

**Positive:**

- Vocabulary stays disciplined. Code review and PR discussion can be specific about which primitive is at play.
- dbRole changes (rare, structural) and businessRole changes (common, claim-shape-driven) follow different review paths.
- Resource-scope cascade can be implemented in the emitter (walks the resource tree) without touching role inheritance logic.

**Negative:**

- Four definers in the constructor is verbose. Users new to the package may not immediately see why `defineDbRoles` and `defineBusinessRoles` are separate.
- We must document the distinction prominently (see `docs/GLOSSARY.md` and `CLAUDE.md`).

## Alternatives considered

- **Single "roles" primitive with a `kind: 'db' | 'business'` discriminator:** rejected — the lookup paths, inheritance semantics, and emitter behavior diverge too much. Discriminator unions where the discriminator changes everything are usually a sign the types should be split.
- **Treat resource cascade as a special form of role inheritance:** rejected — they evaluate at different layers (resource cascade is application-time predicate evaluation; role inheritance is Postgres' role-grant system). Sharing the model conflates the layers.

## References

- [ADR-0011 — Extractable core with Flowchestra preset](./0011-extractable-core-with-flowchestra-preset.md)
- [GLOSSARY.md](../GLOSSARY.md)
