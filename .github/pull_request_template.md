<!-- Title in Conventional Commits format: type(scope): description -->

**What this changes, and why:**

Closes #

**Specification:**

- [ ] No behaviour described in `docs/spec.md` changes, or
- [ ] `docs/spec.md` is updated in this pull request, with a paragraph in `docs/spec-changes.md`

**Operators:**

- [ ] Nothing an operator sees changes, or
- [ ] `CHANGELOG.md`'s `[Unreleased]` section says what changes for them, with **Upgrade notes** for
      anything an upgrade needs beyond deploy/README.md step 8

**Checked locally:**

- [ ] `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`
- [ ] integration harness on Docker (call behaviour, images or compose files changed)
- [ ] integration harness on Podman (`deploy/`, healthchecks or container capabilities changed)

<!--
First pull request? The CLA bot will ask you to sign CLA.md by comment, once (see CONTRIBUTING.md).
-->
