# Zamfono

A cloud PBX for small businesses, 5–20 users. Asterisk 22 carries the media and signalling; a
Node.js control plane drives every call decision over ARI and serves the configuration API. The
whole thing is one Docker Compose stack with one SQLite database.

You administer it through a REST API, through an MCP client such as Claude Code, or by pointing
either at the admin skill in `skills/zamfono/`. There is no web UI.

## What you need

A Linux host running Docker Engine with Compose v2, or Podman 5 with `podman compose`, and:

- **one public IPv4 address for the stack**, reachable on 80 and 443 (TCP), 5060 (UDP and TCP),
  5061 (TCP) and your chosen RTP range (UDP);
- **outbound internet access** for Let's Encrypt, your SIP trunk, your mail relay and your backup
  target.

The stack holds no host-specific values. Everything that varies lives in `.env`.

## Deploying

`deploy/README.md` walks through it step by step: both runtimes, both ways of attaching the stack
to its public address, the firewall rules and the `.env`. In short:

| Overlay                | Use it when                             | What it does                                                                                                   |
| ---------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `compose.ports.yaml`   | one stack on a machine with one address | publishes ports on the host; `EXTERNAL_IPV4` tells Asterisk which address to write into SIP and SDP            |
| `compose.macvlan.yaml` | several stacks on one host              | the `asterisk` container owns a public address on a `macvlan`/`ipvlan` network named `public`; no NAT anywhere |

Every release carries `deploy/` as one download, pinned to that release's images. Unpack it on
the host, run `setup.sh` to write `.env`, and bring it up with the overlay you picked:

```bash
mkdir -p /srv/zamfono && cd /srv/zamfono
curl -fsSL https://github.com/zamfono/pbx/releases/latest/download/zamfono-deploy.tar.gz \
  | tar xz --strip-components=1
./setup.sh              # asks, generates the secrets, writes .env
docker compose -f compose.yaml -f compose.ports.yaml up -d
curl -fsS https://<your FQDN>/healthz
```

## Operating it

`docs/guide/` is written for you rather than for an implementer, and the same pages are served
through the MCP `zamfono.help` tool:

- `mental-model.md` — how a call actually flows, and the vocabulary the API uses
- `routing-order.md` — the order every inbound call is decided in
- `guardrails.md` — what the system refuses to do, and why
- `recipes/` — onboarding an employee, a vacation rule, forwarding calls to an AI agent, diagnosing
  a bad call, undoing a change
- `restore.md` — restoring from a backup
- `emergency-calls.md`, `recording-consent.md`, `music-licensing.md` — the obligations that come
  with running a phone system

Connect an MCP client to administer the stack in plain language:

```bash
claude mcp add --transport http zamfono https://<your FQDN>/mcp
```

## Things worth knowing before you go live

- **Emergency calls.** Read `docs/guide/emergency-calls.md`. A PBX that cannot reach emergency
  services is a liability, and the routing is yours to configure.
- **Recording and consent.** Call recording is off by default and enabled per user or per ring
  group. Recordings and voicemails are personal data; consent and announcement are your
  responsibility (`docs/guide/recording-consent.md`).
- **Backups.** Nothing is backed up until you configure a target. `docs/guide/restore.md` covers
  both directions — practise the restore before you need it.
- **Undo.** Almost every change is reversible through the audit log, and the API tells you when a
  change is not.

## Repository layout

| Path              | What it is                                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy/`         | everything you copy to the host: compose files, overlays, Caddyfile, `.env.example`; each release attaches it as `zamfono-deploy.tar.gz` |
| `docs/guide/`     | the admin guide above                                                                                                                    |
| `CHANGELOG.md`    | what each release changes for operators, with its upgrade notes; each release's description                                              |
| `docs/spec.md`    | the full technical specification — the contract the code is built against                                                                |
| `images/`         | the Dockerfiles for `asterisk`, `migrate`, `api`, `core`, `proxy` and `updater`                                                          |
| `db/`             | the schema migrations and the kysely-ctl configuration the `migrate` image runs                                                          |
| `packages/shared` | the database schema types, wire contracts and shared helpers                                                                             |
| `packages/core`   | the ARI client and the call pipeline                                                                                                     |
| `packages/api`    | the operations layer, REST, MCP, OAuth, events and background jobs                                                                       |
| `skills/zamfono/` | the admin skill for Claude Code and Codex                                                                                                |

## Developing

```bash
npm ci            # every workspace, db/ included, from the one lockfile
npm test          # every package
npm run typecheck
npm run lint
```

The audio suites shell out to `ffmpeg` and skip themselves when it is absent, so a green run on a
machine without it has tested less than it appears to. The image and stack checks are separate
scripts and need a container runtime:

```bash
bash images/asterisk/test.sh   # builds the image and exercises it end to end
bash images/proxy/test.sh      # builds the proxy image: uid 1000, the caddy-events-exec plugin, the hook
bash db/test.sh                # the migrate image, including its retry behaviour
bash deploy/test.sh            # compose config and Caddyfile validation, both node images
bash test/integration/run.sh   # the full sipp-driven stack test (§8); needs the five images built
```

`test/integration/run.sh` also runs single scenarios or named steps without repeating a full stack
bring-up: `ONLY=inbound-hold bash test/integration/run.sh` for one scenario,
`KEEP=1 bash test/integration/run.sh` once to leave the stack up, then
`REUSE=1 ONLY=inbound-hold bash test/integration/run.sh` to rerun against it in seconds — see the
usage block at the top of that file.

To try a pull request's images without building them, a maintainer labels it `publish-image` once
the diff has been read; its green CI run then publishes them as `ghcr.io/zamfono/<name>-pr:<N>`.
A later push takes the label off until its new head has been read too, and closing the pull
request deletes the images. `deploy/compose.pr.yaml` swaps the five images for those, layered last:
`ZAMFONO_VERSION=<N> docker compose -f compose.yaml -f compose.ports.yaml -f compose.pr.yaml up -d`.

## Contributing, security and license

Read `CONTRIBUTING.md` before opening a pull request, and `RELEASING.md` before tagging a release; contributions are accepted under the
contributor license agreement in `CLA.md`, which the CLA bot asks you to sign once. Report
vulnerabilities privately as `SECURITY.md` describes, never in a public issue.

Zamfono is licensed under the GNU Affero General Public License v3.0 (`LICENSE`) by 3angular
Solutions GmbH. The name and logo are not covered by the code license; see `TRADEMARKS.md`.
