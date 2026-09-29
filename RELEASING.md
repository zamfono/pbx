# Releasing

For maintainers. A release is a signed `vX.Y.Z` tag on a commit of `main` that CI has passed;
`.github/workflows/release.yaml` does the rest: it adds the release's tags to the images `main`
already built and tested for that commit, never rebuilding them (`docs/spec.md` §6.3 "Images"),
and publishes the GitHub release with the deploy bundle and its `CHANGELOG.md` section as the
description.

## Choosing the version

From 1.0.0 on, versions follow [Semantic Versioning](https://semver.org/) as written: major for
a breaking change, minor for something new, patch for fixes. Two things are this project's own:

- **What breaks.** Semantic Versioning measures a change against a "public API"; here that is
  everything an operator of a stack deals with, `CHANGELOG.md`'s audience: the REST and MCP
  operations, the `.env` settings, the compose files and the documented commands. A change is
  breaking when its release needs **Upgrade notes** the operator has to act on, such as a newly
  required API field or a changed command.
- **Before 1.0.0**, where Semantic Versioning sets no rule ("anything MAY change at any time"),
  the middle number takes over the major's role, the convention Cargo and npm's `^` ranges read:

  | From `0.X.Y` | When              |
  | ------------ | ----------------- |
  | `0.(X+1).0`  | a breaking change |
  | `0.X.(Y+1)`  | everything else   |

The step from `0.X.Y` to `1.0.0` is a decision, made when the project is ready, not a rule.

## Steps

1. **The changelog commit.** In `CHANGELOG.md`, rename `## [Unreleased]` to
   `## [X.Y.Z] - <YYYY-MM-DD>`, open a new, empty `## [Unreleased]` above it, and update the
   comparison links at the bottom: `[Unreleased]` now compares from `vX.Y.Z`, and a new
   `[X.Y.Z]` line compares the previous release with `vX.Y.Z`. Check that every change an
   operator sees is in the section, and that anything an upgrade needs beyond deploy/README.md
   step 8 is under **Upgrade notes**. The section becomes the release's description as written:

   ```bash
   bash .github/scripts/changelog-section.sh X.Y.Z
   ```

2. **Push `main` and wait for it to pass.** The `release` workflow's run for the commit must end
   green, `publish` included: `promote` tags the images `publish` pushed as
   `sha-<short commit>`, and waits at most 45 minutes for them. A job that failed on a known
   flaky test is re-run (`gh run rerun <run> --failed`); a red commit is never tagged.

3. **Tag that commit and push the tag.** Annotated and signed, on exactly the commit CI passed:

   ```bash
   git tag -a vX.Y.Z -m vX.Y.Z <commit>
   git tag -v vX.Y.Z
   git push origin vX.Y.Z
   ```

   The tag's run refuses a tag that is not `vX.Y.Z`, one on a commit outside `main`, and one
   without a `CHANGELOG.md` section, each before any image is tagged.

4. **Check the release from outside**, signed out, the way an operator gets it:

   ```bash
   base=https://github.com/zamfono/pbx/releases/latest/download
   curl -fsSLO "$base/zamfono-deploy.tar.gz" && curl -fsSLO "$base/SHA256SUMS"
   sha256sum -c --ignore-missing SHA256SUMS
   gh attestation verify zamfono-deploy.tar.gz --repo zamfono/pbx
   tar xzf zamfono-deploy.tar.gz --strip-components=1
   grep -c ':-X.Y.Z}' compose.yaml    # 7: five images and the two ZAMFONO_VERSION defaults
   export DOCKER_CONFIG=$(mktemp -d)   # no stored registry login
   for n in asterisk migrate core api proxy; do docker manifest inspect ghcr.io/zamfono/$n:X.Y.Z >/dev/null && echo "$n ok"; done
   ```

## When a release is broken

Fix forward: the fix goes out as the next release, with the broken one's problem and its remedy
in the new section's **Upgrade notes**. A published tag is never moved or deleted: operators may
already run it, and `latest` names it until the next release does.

## Once, for a new image

A package GitHub Container Registry creates for a new image is private, whatever the
repository's visibility, and an operator's pull then fails with "unauthorized". After the first
release that publishes it, switch it to public: the organization's **Packages** → the package →
**Package settings** → **Change visibility**.
