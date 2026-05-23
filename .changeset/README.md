# Changesets

This directory is managed by [Changesets](https://github.com/changesets/changesets) — the tool we use to track and publish independently-versioned releases of the `@flowchestra/prisma-guarddog-*` packages.

## When to add a changeset

Add a changeset whenever a PR makes a user-visible change to one or more published packages. That includes new features, bug fixes, deprecations, and breaking changes. Internal refactors that don't change the public surface generally don't need one (but adding a small `patch` entry doesn't hurt).

## How to add one

```sh
pnpm changeset
```

The CLI walks you through which packages changed, what bump (`major` / `minor` / `patch`) each one needs, and asks for a short summary. The summary lands in the per-package CHANGELOG when the release lands, so write it for someone reading the changelog later — not for the reviewer of this PR.

## What gets versioned

- All `@flowchestra/prisma-guarddog-*` packages and the unscoped `prisma-guarddog` CLI are versioned **independently** per [ADR-0016](../docs/adr/0016-turborepo-monorepo.md). A change to one emitter does not force a bump on the others.
- The monorepo root and `examples/*` are `private` and never published. The config's `privatePackages.version: false` excludes them.

## Release flow

1. PR adds one or more `.changeset/*.md` files.
2. PR merges to `main`.
3. A "Release" PR is opened automatically by the Changesets GitHub Action (when configured) that bumps versions, updates CHANGELOGs, and removes the consumed changeset files.
4. Merging the Release PR triggers `pnpm changeset:publish`, which builds and publishes the bumped packages to npm.

(The GitHub Action wiring is not yet configured — until then, the version + publish steps are run manually.)

## Config reference

See [`config.json`](./config.json). The schema is documented at <https://github.com/changesets/changesets/blob/main/docs/config-file-options.md>.
