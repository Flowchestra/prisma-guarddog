# Release Notes Command

**Command**: `/release-notes [base-branch]`

**Purpose**: Draft release notes for the current branch in the established Flowchestra format, then publish them to the **Flowchestra Release Notes** Notion database.

## Usage

```text
/release-notes                  # diff against origin/demo (default)
/release-notes origin/main      # diff against a different base
/release-notes <commit-sha>     # diff against a specific revision
```

## What this command does

A linear five-step procedure. Don't skip steps — each one feeds the next.

### 1. Diff the branch vs the base

- Default base: `origin/demo`. If the user passes one, use that.
- Run `git fetch origin <base>` once, then collect:
  - `git log --oneline <base>..HEAD` — commit list (used to detect themes).
  - `git diff --stat <base>..HEAD | tail -3` — file/insertion/deletion totals (used in the body's stats line).
  - `git diff --stat <base>..HEAD | grep "migrations/.*migration.sql" | wc -l` — migration count.
  - Current branch name from `git rev-parse --abbrev-ref HEAD` (used in the `**Branch:**` line).

Don't list every file. The diff stat tail and the commit log are enough to characterize what changed.

### 2. Look up the next version number

The Release Notes database is a Notion database — **don't hardcode the next version**. Fetch it and read the highest existing version number.

- Database ID: `33c356c7-8e8e-80b2-b1f6-efe4fba9226a`
- Data source ID: `33c356c7-8e8e-8087-b6d0-000b5d7ef5f2`
- "All Releases" view URL: `https://www.notion.so/33c356c78e8e80b2b1f6efe4fba9226a?v=33c356c78e8e80cab0e4000c3b015a74` (sorted by Release Date descending)

Use `notion-query-database-view` on that view URL. The first result's `Version` field tells you what's already in flight — pick the next integer minor (`v1.N+1`). Versions in `In Development` status still count; don't overwrite them. Codename is up to the user — propose one based on the dominant theme of the diff and ask for confirmation if it isn't obvious.

### 3. Fetch a recent release as a format reference

Pick the most recent **Released**-status entry (current example: `v1.5 "Session Semantics"`, page id `344356c7-8e8e-801f-881b-db0fdb3bc543`) via `notion-fetch` and mirror its structure. Don't invent a new layout.

The format is:

```markdown
# <Descriptive H1, not a version number>

<1–2 sentence opening paragraph describing the release.>

**Branch:** `<branch-name>`
**N files changed, +X insertions, -Y deletions, M new database migrations**

---

## <Theme 1>

<1–2 sentence intro for the theme.>

- **`thing`** -- description of what shipped
- **Another thing** -- description
- ...

---

## <Theme 2>
...

---

## Code Quality

- Tail section for small cross-cutting cleanups.

---

## Migrations

- `<migration-folder-name>`
- ...

---

## New Environment Variables (1Password-injected)

- `VAR_NAME` -- purpose.

---

## Out of Scope (Deferred)

- Bullet list of explicitly-deferred follow-ups.

---

## Breaking Changes

<Either "None. Purely additive." or a numbered list of caller-facing breaks.>
```

Conventions worth preserving:

- **H1 is descriptive, not the version.** The version goes in the `Version` property; the page title in Notion uses that property.
- **Bullet line format is `**Name** -- description`** (em-dash style). One sentence per bullet ideally.
- **`---` separators between every H2 section.**
- **The `**Branch:**` + stats line is the second paragraph.** Comes from step 1.
- **Inline code via single backticks** for identifiers, file paths, env vars, route paths, and Prisma model/field names.
- **Bold for proper nouns / API names** in running prose, e.g. **`Knowledge Base` toolkit registered** — bold wraps the whole phrase, with backticks scoped to the identifier inside.

### 4. Draft the body

Group commits by theme rather than by chronology — readers care about what shipped, not the order it landed in. Common section headings used in past releases:

- Schema / data-model changes (introduce models, explain invariants).
- Major feature surfaces (one section per surface, e.g. "Two ingestion paths", "Settings → X tab").
- Webhook / cron / background-job changes.
- Auth / security / RLS changes.
- Billing + analytics integration.
- Code quality (tail).
- Migrations (list).
- New environment variables.
- Out of scope / deferred.
- Breaking changes.

If something is intentionally **disabled in the release** (gated off pending follow-up), give it its own dedicated section linking to the tracking issue. See v1.9's "Disabled in This Release" section as the canonical example.

### 5. Create the page in the database

Use `notion-create-pages` with `parent: { type: "data_source_id", data_source_id: "33c356c7-8e8e-8087-b6d0-000b5d7ef5f2" }`.

Property mapping (from the data source schema):

| Property | Type | Notes |
| --- | --- | --- |
| `Version` | title | `v1.N "Codename"` (with the curly quotes) |
| `Status` | status | `In Development` while drafting; the user flips to `Released` after deploy |
| `Type` | select | `Major` / `Minor` / `Patch` / `Hotfix` (Minor is the most common — most releases ship features without breaking compatibility) |
| `Breaking Changes` | checkbox | `__YES__` or `__NO__` (defaults to false) |
| `Priority` | select | `Critical` / `High` / `Medium` / `Low` |
| `date:Release Date:start` | date | ISO-8601 (`YYYY-MM-DD`); set to today unless the user has a target date |
| `date:Release Date:is_datetime` | int | `0` for date-only |
| `Release Manager` | person | `["user://254d872b-594c-8135-90e9-00021501091b"]` (Henry Steele — confirm before changing) |
| `Key Features` | multi-select | JSON-encoded array — pick from `New Integration`, `Performance Improvement`, `UI/UX Enhancement`, `Security Update`, `API Changes`, `Bug Fixes`, `Database Optimization`, `Workflow Automation`. Don't invent new options. |
| `Summary` | text | One paragraph; same content as the Notion DB row's summary field, distinct from the body's opening paragraph (can be similar) |

Body markdown goes into `content`. Don't include the title in the content — the `Version` property surfaces as the page title.

After the page is created, return the URL to the user.

## Interaction style

- This is **interactive**: confirm version + codename + key features with the user before creating the page. Proposing is fine; creating without confirmation is not.
- Surface tradeoffs when relevant ("Type: Minor — it's purely additive. Override to Major if you want to flag size?").
- If the diff stat is unusually large, confirm the base branch — the user may have meant `origin/main`.

## When NOT to use this command

- For a hotfix that doesn't warrant a database entry. Prefer a comment on the existing release page.
- When there's no Notion access this turn (the MCP tools fail). Surface the markdown to the user instead and stop.

## After-merge: cutting the GitHub release

This command writes the **detailed** notes (Notion). The **GitHub release** that points at them is intentionally lightweight — current convention since v1.3 is just `gh`'s auto-generated "What's Changed" PR list, plus a Notion link, plus the Full Changelog compare URL. The detailed prose lives in Notion; GitHub is an index.

When the user is ready to cut the GitHub release after the PR merges, propose this template (do **not** run it without confirmation — version tags are visible to all repo watchers and hard to revert):

```bash
gh release create vX.Y.0 \
  --repo ByteSizeInnovations/Flowchestra \
  --title "vX.Y.0" \
  --generate-notes \
  --notes "$(cat <<'EOF'
## What's Changed

<!-- gh will auto-populate this with the merged-PR list when --generate-notes is set;
     paste in additional commentary here only if needed. -->

**Full Release Notes**: <Notion page URL from step 5>

**Full Changelog**: https://github.com/ByteSizeInnovations/Flowchestra/compare/v<prev>.0...vX.Y.0
EOF
)"
```

Notes:

- **Title** is `vX.Y.0` — three-part semver tag, no codename. The codename lives in the Notion page title (`Version` property), not the GitHub tag.
- **`--generate-notes`** populates the `## What's Changed` section automatically from merged PR titles. Don't hand-write it.
- The Notion URL works whether or not it has the slug — `https://www.notion.so/<page-id>` is fine; GitHub redirects through Notion.
- Compare URL convention is `compare/v<prev>.0...v<new>.0` (omit the codename).

## See also

- [v1.5 "Session Semantics"](https://www.notion.so/344356c78e8e801f881bdb0fdb3bc543) — canonical format reference.
- [v1.9 "Knowledge Base"](https://www.notion.so/35a356c78e8e815496e7f82dce528e1a) — example with a "Disabled in This Release" section linking to a tracking issue.
- [Flowchestra Release Notes database](https://www.notion.so/33c356c78e8e80b2b1f6efe4fba9226a) (root).
