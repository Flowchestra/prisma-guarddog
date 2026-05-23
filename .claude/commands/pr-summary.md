# PR Summary Command

**Command**: `/pr-summary [base-branch]`

**Purpose**: Draft a pull-request description for the current branch using the project's established PR template, ready to paste into GitHub.

## Usage

```text
/pr-summary                  # diff against origin/demo (default base for feature branches)
/pr-summary origin/main      # diff against main (for hotfix / release-cut PRs)
/pr-summary <commit-sha>     # diff against a specific revision
```

## What this command does

Returns the PR body as **raw markdown** in the chat — do not write it to a file unless asked. The user pastes it into the GitHub PR form themselves. If the user explicitly says "open the PR" or "create the PR", use `gh pr create` after confirming the title and body.

### 1. Diff the branch vs the base

- Default base: `origin/demo`. If the user passes one, use that.
- Refresh the remote first. `git fetch` takes a remote + optional ref, not a `remote/branch` slug, so split before fetching: `origin/main` → `git fetch origin main`; bare `main` → `git fetch origin main`; a commit SHA → `git fetch origin` (just refresh refs). Then use the original arg as the revspec for log/diff.
- Collect:
  - `git log --oneline <base>..HEAD` — commit list (used to detect themes).
  - `git diff --stat <base>..HEAD | tail -3` — file/insertion/deletion totals.
  - `git diff --stat <base>..HEAD | grep "migrations/.*migration.sql"` — to detect schema changes.
  - Branch name from `git rev-parse --abbrev-ref HEAD`.

Don't enumerate every changed file. Group them mentally by theme: schema, API routes, UI, tooling, etc.

### 2. Map the diff onto the template

The required template is below. Fill **every section**, even if briefly. Skipping sections silently makes reviewers wonder what's missing.

```markdown
## Summary

<1-paragraph "what + why" — not "I changed X, Y, Z". Lead with user-visible
impact; back it up with the architectural change.>

### Highlights

- **Bold heading** -- one-sentence description of a notable change.
- ...

## Related Issue

<"Fixes #N" or "Follow-up: #N" or "None.">

## Type of Change

<!-- Check the types of changes introduced in this PR -->

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update
- [ ] Refactoring (no functional changes)
- [ ] Performance improvements
- [ ] Build or dependency updates

## Testing Performed

<!-- Describe the testing you've done to verify your changes -->

- [ ] Unit tests
- [ ] Integration tests
- [ ] Manual testing
- [ ] Accessibility testing

<numbered list of what you actually exercised — golden path + edge cases. Mention `pnpm tsgo` and `pnpm oxlint` results if you ran them.>

## Screenshots/Recordings

<Either attached screenshots/videos, or "_To be attached: <list>_" if the user
hasn't captured them yet, or remove the section if it's a backend-only PR.>

## Checklist

<!-- Verify that your PR meets the following requirements -->

- [ ] Code follows the project's style guidelines
- [ ] Code has been self-reviewed
- [ ] Comments have been added for complex parts of the code
- [ ] Documentation has been updated (if necessary)
- [ ] Changes generate no new warnings or errors
- [ ] New and existing tests pass locally
- [ ] Dependencies have been updated if necessary

## Additional Notes

<Anything reviewers must know that didn't fit elsewhere: deferred work,
disabled features behind flags, follow-up issues, breaking changes for
downstream consumers, deployment ordering, env-var additions, migrations
that need `prisma migrate deploy` before app deploy, etc.>
```

### 3. Conventions to apply consistently

- **Type of Change** — check the boxes that genuinely apply. Most feature PRs check `New feature` AND `Refactoring` if they touch unrelated code paths. Don't blanket-check; reviewers look at this.
- **Testing Performed** — only check the boxes that actually happened. If you didn't run integration tests, don't check the box. Append a numbered list of the manual scenarios you walked through.
- **Highlights bullets** use the same `**Name** -- description` em-dash form as the release notes. Keeps voice consistent.
- **Architectural choices belong in Additional Notes**, not Summary. Summary is for "what does this do for users."
- **Migrations** — if any are present, list them in Additional Notes with the `prisma migrate deploy` reminder.
- **Env vars** — if any are added, list them with their purpose in Additional Notes.
- **Disabled-but-shipped features** (e.g. a tool gated off pending follow-up) get an explicit subsection in Additional Notes referencing the tracking issue.
- **Inline code via single backticks** for identifiers, file paths, env vars, route paths, model/field names.

### 4. Output

Paste the populated template into the chat as a fenced markdown block, ready to copy. Do not write to a file. Do not run `gh pr create` unless the user explicitly says so.

If the user does ask you to create the PR:

- Confirm the title (under 70 chars; lead with the verb — `feat:`, `refactor:`, `fix:` as appropriate).
- Use `gh pr create --title "<title>" --body "$(cat <<'EOF' …)"` with the full body.
- Return the PR URL when done.

## Interaction style

- **Confirm the base branch when the diff is unusually large.** A 100+ file diff against `origin/demo` is normal for feature branches; against `origin/main` it's almost always wrong base.
- **Ask before checking ambiguous boxes.** "Did you do accessibility testing?" is one quick question and a more accurate template.
- **Don't fabricate test runs.** If you're not sure whether something was tested, leave the checkbox unchecked and note it explicitly. Reviewers reading PR descriptions are sensitive to this.

## Release-funnel implications

Merged PR titles funnel into the GitHub release body's auto-generated "What's Changed" list (e.g. `* Full version 1 Analytics implementation by @Henry-Steele in #154`). That means the PR title is the **only** prose about the change visible in the GitHub release entry — the body is collapsed. Keep that in mind:

- **Make the title self-contained.** A reader skimming the release on GitHub should understand the change from the title alone. `feat: ship X` beats `WIP fixes`.
- **Conventional-commit prefix is fine but not required** — older releases mix styles. Match the style of recently merged PRs.
- **Keep titles ≤70 chars** so they don't wrap awkwardly in the release auto-list.

The PR body itself is for reviewers, not for the release. Don't pad it with content already in the linked Notion release notes.

## See also

- `/release-notes` — the sibling command that turns the same diff into a Notion Release Notes entry. Run `/release-notes` after `/pr-summary` when you're ready to ship.
- [v1.9 "Knowledge Base"](https://www.notion.so/35a356c78e8e815496e7f82dce528e1a) — example of a PR + release-notes pair driven from the same diff.
