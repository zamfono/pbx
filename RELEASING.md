# Releasing

For maintainers. A release is a signed `vX.Y.Z` tag on a commit of `main` that CI has passed;
`.github/workflows/release.yaml` does the rest: it adds the release's tags to the images `main`
already built and tested for that commit, never rebuilding them (`docs/spec.md` §6.3 "Images"),
and publishes the GitHub release with the deploy bundle and its `CHANGELOG.md` section as the
description: as a draft first, with the bundle attached, then published, since a published
release takes no more assets (below).

## Choosing the version

From 1.0.0 on, versions follow [Semantic Versioning](https://semver.org/) as written: major for
a breaking change, minor for something new, patch for fixes. Two things are this project's own:

- **What breaks.** Semantic Versioning measures a change against a "public API"; here that is
  everything an operator of a stack deals with, `CHANGELOG.md`'s audience: the REST and MCP
  operations, the `.env` settings, the compose files and the documented commands. A change is
  breaking when its release needs **Upgrade notes** the operator has to act on, such as a newly
  required API field or a changed command. The choice has a consequence: `system.update` and the automatic update install any newer
  release that is not breaking without an operator reading its notes, so a release it may take
  needs nothing beyond what `update.sh` does itself.
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

2. **Push `main` and wait for it to pass.** The `main` workflow's run for the commit must end
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
   grep -c ':-X.Y.Z}' compose.yaml    # 9: five services' images, netns's proxy image, stun's asterisk image and the two ZAMFONO_VERSION defaults
   # DIGESTS: six lines, asterisk, migrate, core, api, proxy and updater, each the digest the tag names.
   while read -r n d; do docker buildx imagetools inspect "ghcr.io/zamfono/$n:X.Y.Z" | grep -q "^Digest: *$d$" && echo "$n $d ok"; done <DIGESTS
   gh release view vX.Y.Z --repo zamfono/pbx --json isDraft,isImmutable   # false, true
   export DOCKER_CONFIG=$(mktemp -d)   # no stored registry login
   for n in asterisk migrate core api proxy updater; do docker manifest inspect ghcr.io/zamfono/$n:X.Y.Z >/dev/null && echo "$n ok"; done
   ```

## When a release is broken

Fix forward: the fix goes out as the next release, with the broken one's problem and its remedy
in the new section's **Upgrade notes**. A published tag is never moved or deleted: operators may
already run it, and `latest` names it until the next release does. GitHub enforces both (below);
only the release's title and notes can still be edited.

If the tag's run fails after `promote`, re-run its failed jobs. A re-run of `bundle` finishes a
draft it finds; against a release already published it uploads nothing, checks that the published
assets are the bytes it packed again (the bundle is reproducible) and replaces the notes only, and
it fails where they differ, which needs looking into before anything else.

## What protects a published release

An operator's stack installs a release as root, and on its own where automatic updates are on, so
what a release contains must not change once published:

- **Immutable releases**, a repository setting: once a release is published, its assets and its
  tag can no longer be changed or deleted, only its title and notes
  (<https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases>).
  Releases published before it was turned on, 0.9.1 and earlier, stay mutable.
- **A tag ruleset** forbids deleting or moving any `v*` tag, for everyone.
- **`SHA256SUMS`** of the same release: `update.sh` checks the bundle against it, and since
  neither can change after publication, nor can the pair.
- **`DIGESTS`** in the bundle, which `SHA256SUMS` covers: each image's index digest for the
  release, the one `promote` gave every tag. Registry tags are protected by neither of the above,
  so `update.sh` checks every release image it pulled against it before it changes anything, and
  `setup.sh` in a release's bundle before it writes `.env`. A stack on `edge` is not checked.
- **The provenance attestation** of the two archives, which an operator can check by hand
  (deploy/README.md, step 4); `update.sh` does not, since Debian's `gh` cannot.

What remains: whoever holds a maintainer's token or session with write access can push a commit to
`main`, tag it and cut an ordinary release through `release.yaml`, with a valid attestation and
`DIGESTS`, which every automatically updating stack then installs. That is accepted for now. Only a
key the maintainer holds offline would cover it, such as `SHA256SUMS` signed with an SSH key and
checked by `update.sh` against an `allowed_signers` file in the bundle it runs.

## Once, for a new image

A package GitHub Container Registry creates for a new image is private, whatever the
repository's visibility, and an operator's pull then fails with "unauthorized". After the first
release that publishes it, switch it to public: the organization's **Packages** → the package →
**Package settings** → **Change visibility**.
