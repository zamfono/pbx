# Contributing

Issues and patches are welcome. Please open an issue before starting on a patch of any size — the
stack is opinionated and specified in detail, and agreeing on the approach first saves you from
building something that cannot merge.

## What belongs here

The Compose stack and everything in it: the call pipeline in `core`, the REST, MCP and OAuth
surface in `api`, the schema and its migration, the images, the compose files and the admin guide.
Bugs in Asterisk itself belong upstream — see the note in `SECURITY.md`.

## The specification

`docs/spec.md` is the contract the code is built against. A change that alters behaviour it
describes changes the specification too, in the same pull request, as the smallest edit that
does it, and adds a paragraph to the change log at its top (`**<date> · <section>.** <change>`,
then `*Why:* <reason>`, newest first).

## Pull requests

- Open a pull request against `main`; the `ci` and `cla` checks must be green.
- Run the checks locally first (see "Developing" in `README.md`):
  `npm test`, `npm run typecheck`, `npm run lint` and `npm run format:check`.
- A change to call behaviour, the images or the compose files also runs the integration harness,
  `bash test/integration/run.sh`, on Docker, and on Podman too when it touches `deploy/`,
  healthchecks or container capabilities.
- Write commit messages in Conventional Commits format (`type(scope): description`).
- Keep changes minimal and place explanatory comments at the point of use.

## Contributor license agreement

Zamfono is licensed under AGPL-3.0 (`LICENSE`), and 3angular Solutions GmbH, which publishes it,
also offers it under other terms, such as commercial licenses. That is only possible while every
contribution may be distributed under both, so contributions are accepted under a contributor
license agreement, `CLA.md`. You keep the copyright in your work; the agreement grants 3angular a
license to distribute it under any terms, including AGPL-3.0.

On your first pull request the CLA bot asks you to sign by commenting

> I have read the CLA and I hereby sign it.

once. That covers all your later pull requests too.
