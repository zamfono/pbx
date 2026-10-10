# Security policy

## Scope

This repository builds the Zamfono Compose stack and publishes its images at
`ghcr.io/zamfono/{asterisk,migrate,core,api,proxy,updater}`. Security reports belong here when
they concern:

- the control plane: authentication, sessions, roles and scopes, OAuth and SSO, the REST and MCP
  surfaces, webhook signatures, the handling of stored secrets;
- the call pipeline: a call reaching a destination, a trunk or a recording it should not;
- the images and the compose files as published (a default that exposes something it should not,
  a tampered image);
- the release pipeline that builds, tests and publishes the images.

Vulnerabilities in Asterisk itself are upstream software vulnerabilities: report them to the
[Asterisk project's security
process](https://docs.asterisk.org/Asterisk-Community/Asterisk-Issue-Guidelines/), not here. The
same goes for the other upstream software the stack runs, such as Caddy, Node.js and ffmpeg.
Weaknesses in one operator's own deployment (its `.env`, host or network) are the operator's to
fix.

## Reporting

Report privately via GitHub's ["Report a
vulnerability"](https://github.com/zamfono/pbx/security/advisories/new) form. Please do not open
a public issue for anything exploitable.

## Supported versions

Only the newest release receives fixes — every release supersedes its predecessors. Pull the
newest tag, or `latest`, to pick up a fix.
