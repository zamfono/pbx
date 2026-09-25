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

Copy `deploy/` to the host and fill in `.env`:

```bash
cp deploy/.env.example deploy/.env
```

Then pick how the stack reaches its public address — this is the one structural decision, and it
is the overlay you name on every `docker compose` command from then on:

| Overlay                | Use it when                             | What it does                                                                                                   |
| ---------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `compose.ports.yaml`   | one stack on a machine with one address | publishes ports on the host; `EXTERNAL_IPV4` tells Asterisk which address to write into SIP and SDP            |
| `compose.macvlan.yaml` | several stacks on one host              | the `asterisk` container owns a public address on a `macvlan`/`ipvlan` network named `public`; no NAT anywhere |

Generate the secrets `.env` asks for:

```bash
openssl rand -base64 32                       # JWT_SECRET
printf '1:%s' "$(openssl rand -base64 32)"    # SECRETBOX_KEY
```

The owner's password hash comes from the `api` image itself, so you never type a password into a
file:

```bash
read -rs PW && printf '%s' "$PW" | docker compose run --rm --no-deps -T api node hash-password.mjs
```

Put the result in `.env` **in single quotes**. An Argon2id hash contains `$`, and Compose reads an
unquoted `$` as a variable reference — the hash arrives at the container with pieces missing and
the owner can never log in:

```bash
BOOTSTRAP_OWNER_PASSWORD_HASH='$argon2id$v=19$m=65536,p=4,t=3$...'
```

Leave `BOOTSTRAP_OWNER_PASSWORD_HASH` empty instead and the owner gets a set-password mail — which
needs `SMTP_HOST` to be set.

Bring it up:

```bash
docker compose -f compose.yaml -f compose.ports.yaml up -d
```

The `migrate` container applies the schema and exits before `api` starts. On the first boot with an
empty database, `api` seeds the owner, the settings, your `MAIN_DID`, nine parking slots and the
bundled hold music — then never seeds again.

Check it came up:

```bash
curl -fsS https://<your FQDN>/healthz
```

## Operating it

`docs/guide/` is written for you rather than for an implementer, and the same pages are served
through the MCP `zamfono.help` tool:

- `mental-model.md` — how a call actually flows, and the vocabulary the API uses
- `routing-order.md` — the order every inbound call is decided in
- `guardrails.md` — what the system refuses to do, and why
- `recipes/` — onboarding an employee, a vacation rule, diagnosing a bad call, undoing a change
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

| Path              | What it is                                                                          |
| ----------------- | ----------------------------------------------------------------------------------- |
| `deploy/`         | everything you copy to the host: compose files, overlays, Caddyfile, `.env.example` |
| `docs/guide/`     | the admin guide above                                                               |
| `docs/spec.md`    | the full technical specification — the contract the code is built against           |
| `images/`         | the Dockerfiles for `asterisk`, `api`, `core` and `proxy`                           |
| `db/`             | the schema migration and the one-shot `migrate` image                               |
| `packages/shared` | the database schema types, wire contracts and shared helpers                        |
| `packages/core`   | the ARI client and the call pipeline                                                |
| `packages/api`    | the operations layer, REST, MCP, OAuth, events and background jobs                  |
| `skills/zamfono/` | the admin skill for Claude Code and Codex                                           |

## Developing

```bash
npm ci
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

Read `CONTRIBUTING.md` before opening a pull request; contributions are accepted under the
contributor license agreement in `CLA.md`, which the CLA bot asks you to sign once. Report
vulnerabilities privately as `SECURITY.md` describes, never in a public issue.

Zamfono is licensed under the GNU Affero General Public License v3.0 (`LICENSE`) by 3angular
Solutions GmbH. The name and logo are not covered by the code license; see `TRADEMARKS.md`.
