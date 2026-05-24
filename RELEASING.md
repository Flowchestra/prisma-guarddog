# Releasing

`prisma-guarddog` ships nine packages under the `@flowchestra/` scope to **GitHub Packages**. Releases are driven by [Changesets](https://github.com/changesets/changesets); the alpha line lives in changesets' [pre mode](https://github.com/changesets/changesets/blob/main/docs/prereleases.md), so versions look like `0.1.0-alpha.<n>` until we exit prerelease.

> Packages live at https://github.com/orgs/flowchestra/packages and inherit visibility from the source repo.

## Authoring a change

Every PR that touches a package must include a changeset:

```sh
pnpm changeset
```

The prompt asks which packages changed and what bump severity each one needs. Commit the generated `.changeset/<slug>.md` file alongside your code change. The PR description should not duplicate the changeset content — the changeset *is* the user-facing changelog entry.

In pre mode, severity choices map to:

- `patch` → `0.1.0-alpha.<n+1>`
- `minor` → still `0.1.0-alpha.<n+1>` (severity is preserved for when we exit pre)
- `major` → still `0.1.0-alpha.<n+1>`

The bump level only matters once pre mode exits. While in alpha, every applied changeset just increments the alpha counter.

## Cutting a release (CI path — recommended)

1. Land PRs containing changesets on `main`.
2. The `.github/workflows/release.yml` "release" workflow runs on push to `main`. It opens (or updates) a "Version Packages" PR that consumes all unreleased changesets and bumps versions.
3. Review and merge the version PR. The same workflow then runs `changeset publish` against GitHub Packages.

The CI workflow uses the repo's `GITHUB_TOKEN` for both PR management and the npm publish — no PAT plumbing required.

## Cutting a release (local path — for first-time setup or emergencies)

You need:

1. **A Personal Access Token (classic)** with `read:packages` + `write:packages` scopes (and `repo` if the source repo is private). Generate at https://github.com/settings/tokens.
2. **A local untracked `.npmrc` line** providing that token (do **not** commit it):

   ```sh
   echo "//npm.pkg.github.com/:_authToken=$YOUR_GH_TOKEN" >> ~/.npmrc
   ```

   (Or use a repo-local `.npmrc.local` and a wrapper script — the existing `.npmrc` already routes `@flowchestra:*` to GitHub Packages, so the only thing you're adding is the auth line.)

3. **Verify the workspace is releasable**:

   ```sh
   pnpm install
   pnpm -r run type-check             # tsgo across every package
   pnpm -r run test                   # unit tests, no DB required
   pnpm test:e2e                      # boots throwaway postgres:16, runs full E2E, tears down
   pnpm -r run build                  # build dist/ for every package
   ```

   The CI release gate runs the same set; doing it locally before publishing catches the same things one round-trip earlier.

4. **Apply pending changesets** and publish:

   ```sh
   pnpm exec changeset version        # consumes .changeset/*.md, bumps package.jsons + CHANGELOG.md
   pnpm install                       # refresh lockfile after version bumps
   pnpm -r run build                  # rebuild dist/ post-version-bump
   pnpm exec changeset publish        # publishes to GitHub Packages
   git add . && git commit -m "release: <versions>"
   git push --follow-tags
   ```

## Pre-release lifecycle

The repo currently sits in `pre alpha` mode (look for `.changeset/pre.json`). The release workflow:

- **Entering pre mode** (already done): `pnpm exec changeset pre enter alpha`. After this, every `changeset version` produces an alpha version.
- **Exiting pre mode** when ready for a stable 0.1.0 release: `pnpm exec changeset pre exit`, then `pnpm exec changeset version` to apply the accumulated changesets at their declared severities, then publish as usual.

Snapshot publishes (one-off builds for testing without consuming changesets) are also supported:

```sh
pnpm exec changeset version --snapshot pr123
pnpm exec changeset publish --tag pr123
```

These don't write to `.changeset/`, don't move the canonical version, and the published tarballs are tagged so they never become `latest`.

## What gets published

Each `package.json` declares `publishConfig` pointing at the built `dist/` outputs and `registry: https://npm.pkg.github.com`. The example package (`examples/flowchestra`) has `"private": true` so changesets skips it. The CLI's `bin.ts` reads its version from `package.json` at runtime so `guarddog --version` always reflects the published version.

Changesets respects the `ignore` list and `privatePackages` config in `.changeset/config.json`; the example stays private indefinitely, and there are no other ignored packages.

## Consumer install (for downstream apps like Flowchestra)

Consumers need two `.npmrc` lines — typically in the repo or `~/.npmrc`:

```ini
@flowchestra:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Then `pnpm add @flowchestra/prisma-guarddog @flowchestra/prisma-guarddog-core …` works as expected. The `GITHUB_TOKEN` only needs `read:packages` for consuming.

## Troubleshooting

- **`401 Unauthorized` on publish** — your PAT is missing `write:packages` or expired.
- **`403 Forbidden` on publish** — the package's repository URL must point at a repo owned by the same org/user as the npm scope. Check `repository.url` in each `package.json` and make sure the repo lives under the `flowchestra` GitHub org.
- **`404 Not Found` on install** — consumer's `.npmrc` is missing the `@flowchestra:registry=…` line, or the auth token lacks `read:packages`.
- **Workflow won't open a version PR** — check that the workflow has `pull-requests: write` and `contents: write` permissions in its `permissions:` block.

## Where things live

- [`.changeset/config.json`](./.changeset/config.json) — changesets behavior (changelog generator, access, base branch).
- [`.changeset/pre.json`](./.changeset/pre.json) — exists while in pre mode; contains the current alpha state.
- [`.changeset/*.md`](./.changeset/) — pending changesets waiting to be consumed.
- [`.github/workflows/release.yml`](./.github/workflows/release.yml) — CI publish path.
- [`.npmrc`](./.npmrc) — workspace-wide scope routing (auth tokens are NOT here).
