# Kanban release workflow

## Overview

This repository uses these GitHub Actions workflows for quality gates, publishing and the image:

- `.github/workflows/test.yml`
  - Reusable test workflow used by CI and Publish workflows.
  - Runs build, checks, and web-ui unit tests.
- `.github/workflows/ci.yml`
  - Runs on pushes and pull requests targeting `main`.
  - Calls the reusable `test.yml` workflow.
- `.github/workflows/publish.yml`
  - Runs when a version tag `vX.Y.Z[-prerelease]` is pushed, or by hand (`workflow_dispatch`) for an existing tag.
  - Publishes `@vombor/kanban` to GitHub Packages (`npm.pkg.github.com`) and creates the GitHub release.
  - Uses the repository secret `GH_PAT` (the user's classic PAT, see `docs/fork/github-auth.md`) for both;
    the workflow fails at its first step without it.
- `.github/workflows/image.yml`
  - Runs on pushes to `fork/**` and daily; builds and pushes the dev-container image to GHCR. It publishes no npm
    package.

## Contributor workflow

For regular development:

- Open a PR to `main` (or push to the fork's stack branch).
- CI runs `test.yml` automatically.
- Merge once checks pass.

## Cutting a release

1. Bump `package.json` `version` (fork versions are `0.1.70-fork.N`) and the two `version` fields at the top of
   `package-lock.json`. Edit the lock file by hand: `npm install --package-lock-only` re-indents all of it with tabs.
2. Add a `## [<version>]` section to `CHANGELOG.md` (format below). The publish fails without one.
3. Commit and push those changes.
4. Create and push the matching tag:

```bash
git tag v0.1.70-fork.5
git push origin v0.1.70-fork.5
```

Pushing the tag starts `publish.yml`. To re-run it for an existing tag: Actions → Publish → Run workflow, or
`gh workflow run publish.yml -f tag=v0.1.70-fork.5`.

`CHANGELOG.md` section format (what `.github/scripts/extract-changelog-entry.mjs` reads):

```markdown
## [0.1.70-fork.5]

- Entry here
```

## What publish.yml does

Given the tag (the pushed tag, or the `tag` input):

1. Fails at once when the `GH_PAT` secret is missing.
2. Runs the reusable test workflow (`test.yml`).
3. Validates tag format (`vX.Y.Z` with optional prerelease suffix), verifies the tag exists and checks out its commit.
4. Verifies the `package.json` name is `@vombor/kanban` (an upstream tag stops here) and `tag == v${package.json version}`.
5. Extracts the matching version section from `CHANGELOG.md`.
6. Runs `npm run prepublishOnly` (build + checks).
7. Publishes with `NODE_AUTH_TOKEN` = `GH_PAT`:

```bash
npm publish --tag next     # prerelease versions (anything with a "-"), e.g. 0.1.70-fork.5
npm publish --tag latest   # releases
```

   The registry comes from `publishConfig.registry` in `package.json`. GitHub Packages has no npm provenance, and
   a package linked to the repository (`repository` in `package.json`) gets the repository's visibility.
8. Creates a GitHub Release for the tag (with `GH_PAT`), with that changelog section as the body, a compare link
   to the previous tag, and marked prerelease for a prerelease tag.

## Installing from GitHub Packages

GitHub Packages needs a token to install, even for a public package: a PAT with `read:packages`.

```ini
# ~/.npmrc
@vombor:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```bash
export GITHUB_TOKEN=<PAT with read:packages>
npm install -g @vombor/kanban@next     # fork prereleases
npx @vombor/kanban
```

In the dev container the entrypoint writes the same lines with `${GH_TOKEN}` (`docs/fork/github-auth.md`).

## Expected failure cases

Publish will fail if:

- The `GH_PAT` secret is missing, or the PAT lacks `write:packages` / `repo`.
- The tag does not exist or does not match the `package.json` version.
- `CHANGELOG.md` is missing, or its section for that version is missing or empty.
- Build/tests/checks fail.
- That version is already on GitHub Packages (versions can't be overwritten; bump and tag again).
