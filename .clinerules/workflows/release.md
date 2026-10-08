# Release Workflow

See @RELEASE_WORKFLOW.md - you will assist with updating the changelog, bumping vesion, tagging and optionally publishing.

### 1. Sync and gather context

```bash
git fetch origin --tags
git checkout fork/stack
git pull origin fork/stack   # the fork releases from fork/stack, not main
```

Determine the latest tag:

```bash
git tag --sort=-v:refname | head -1
```

If no tags exist, use the first commit as the baseline.

Read the current version from `package.json`.

### 2. Collect commits since last tag

```bash
git log <last-tag>..HEAD --oneline --no-merges
```

Or if no tags exist:

```bash
git log --oneline --no-merges
```

### 3. Check for Cline SDK version changes

Compare the `@clinebot/core` version in `package.json` at the last tag vs HEAD:

```bash
git show <last-tag>:package.json  # extract @clinebot/core version
cat package.json                   # extract current @clinebot/core version
```

If the version changed, gather the SDK changelog to include in the release notes:

1. Look up the git commit hash for both the old and new versions:
   ```bash
   npm view @clinebot/core@<old-version> gitHead
   npm view @clinebot/core@<new-version> gitHead
   ```
   If `gitHead` is not available for the new version, use the commit from the SDK repo's version bump commit instead (e.g. search for "Cline SDK <version>" in the commit log).

2. Get the commits between those two hashes from the SDK repo (`cline/sdk-wip`):
   ```bash
   gh api "repos/cline/sdk-wip/compare/<old-hash>...<new-hash>" --jq '.commits[] | "\(.sha[0:7]) \(.commit.message | split("\n")[0])"'
   ```

3. Filter to user-facing changes only (same inclusion/exclusion rules as step 4 below). For commits with unclear messages, read the full commit from the SDK repo to understand what changed.

4. Incorporate SDK changes into the changelog draft in step 4 as a single bullet point summarizing the version bump and its notable changes, e.g.:
   - Updated Cline SDK from 0.0.X to 0.0.Y, which includes: <comma-separated list of notable changes>

### 4. Curate the changelog

From the commit list, draft a user-facing changelog as a bullet list. This is part marketing -- YouTubers and users read these.

- Include: new features (`feat`), bug fixes (`fix`), notable performance improvements (`perf`), breaking changes
- Exclude: refactors (`refactor`), chores (`chore`), CI changes (`ci`), tests (`test`), docs (`docs`), style changes (`style`), internal renames
- No grouping by category -- just a flat list of bullet points
- Write entries as user-friendly descriptions (not raw commit messages). Describe what changed from the user's perspective, not implementation details
- If a scope is present in the commit (e.g. `feat(web-ui): ...`), use it to inform the description but don't include the scope prefix in the changelog entry
- When the commit message alone isn't descriptive enough to write a meaningful changelog entry, read the full commit (message body, diff, changed files) to understand what actually changed before writing the entry
- Order entries from most impactful to least impactful. User-facing features and major bug fixes come first, minor UI tweaks and internal changes come last

Present the draft changelog to the user:

```
Here's the proposed changelog for this release:

<draft entries>

Does this look good, or would you like changes?
```

Wait for the user to approve or give feedback. Iterate until approved.

### 5. Determine version bump

Ask the user:

```
Bump patch (0.1.0 -> 0.1.1) or minor (0.1.0 -> 0.2.0)?
```

Wait for their answer.

### 6. Update files

Update `package.json` version field to the new version.

Update the two `version` fields at the top of `package-lock.json` by hand (`npm install --package-lock-only` re-indents the whole file with tabs).

Create or prepend to `CHANGELOG.md`. The format must match what `.github/scripts/extract-changelog-entry.mjs` expects:

```markdown
## [<version>]

- Entry here
- Entry here
```

If `CHANGELOG.md` already exists, prepend the new section after any top-level heading (like `# Changelog`). If it doesn't exist, create it with a `# Changelog` heading followed by the new section.

### 7. Commit and tag

```bash
git add CHANGELOG.md package.json package-lock.json
git commit -m "v<version> release notes"
git tag v<version>
```

### 8. Push

Push the commit to the release branch (the fork releases from `fork/stack`), then the tag. Pushing the tag starts `publish.yml`: it runs the tests, publishes `@vombor/kanban` to GitHub Packages (`next` for a prerelease version, `latest` otherwise) and creates the GitHub release, all with the repo secret `GH_PAT` (docs/fork/github-auth.md).

```bash
git push origin <branch>
git push origin v<version>
```

### 9. Follow the publish run

The tag push already started it. Only to re-run it for an existing tag: `gh workflow run publish.yml -f tag=v<version>`.

Show the link to the workflow run:

```bash
gh run list --workflow=publish.yml --limit=1 --json url --jq '.[0].url'
```
