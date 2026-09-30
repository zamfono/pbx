# Deploying Zamfono

Step by step, from a blank Debian 13 host to a running stack. Every other distribution works too;
only the package commands in step 2 differ. The design behind these steps is
[`docs/spec.md` §6](https://github.com/zamfono/pbx/blob/main/docs/spec.md#6-deployment-docker-compose).

Every release on GitHub carries these files as one download, `zamfono-deploy.tar.gz` (or `.zip`),
with `compose.yaml` pinned to that release's images (step 5):

| File                   | What it is                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `compose.yaml`         | the stack; on its own it has no public reachability                                                     |
| `compose.ports.yaml`   | overlay: one stack on the host's own address, through published ports                                   |
| `compose.macvlan.yaml` | overlay: the stack owns a public address of its own on a `public` network                               |
| `Caddyfile`            | the HTTPS front, Let's Encrypt included                                                                 |
| `.env.example`         | every value the stack reads; copy to `.env`                                                             |
| `litestream.caddy`     | disaster-recovery add-on ([`docs/spec.md` §6.5](https://github.com/zamfono/pbx/blob/main/docs/spec.md)) |

`compose.pr.yaml` and `test.sh` stay in the repository: one runs a pull request's images for
review, the other tests this directory.

## 1. Pick a mode and a runtime

**Mode.** The one structural decision, and the overlay you name on every `compose` command from
then on:

| Mode                     | Use it when                                                  | Overlay                |
| ------------------------ | ------------------------------------------------------------ | ---------------------- |
| **A — one IP**           | one stack on a VPS or server with one public IPv4            | `compose.ports.yaml`   |
| **B — one IP per stack** | several stacks on one host, each on its own routed public IP | `compose.macvlan.yaml` |

**Runtime.** Docker Engine with Compose v2, or Podman 5 run as root. CI runs the stack on both.
Commands below are written with `docker compose`; on Podman type `podman compose` instead, with
the same arguments.

## 2. Install the runtime

### Docker

Install Docker Engine and its Compose plugin from Docker's own repository
(<https://docs.docker.com/engine/install/debian/>):

```bash
apt-get update && apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
```

**Mode A only:** turn off the userland proxy. Otherwise Docker starts one `docker-proxy` process
for each of the ~200 published RTP ports:

```bash
echo '{ "userland-proxy": false }' > /etc/docker/daemon.json
systemctl restart docker
```

Docker brings `unless-stopped` containers back after a reboot by itself.

### Podman

Run everything as root. Rootless Podman can bind neither ports below 1024 nor a macvlan address.
Podman needs a systemd host, since it runs healthchecks and restart policies through systemd.

```bash
apt-get update
apt-get install -y --no-install-recommends podman aardvark-dns docker-compose
systemctl enable --now podman.socket
```

`aardvark-dns` is what lets the services find each other by name. Without it `core` fails to
reach `asterisk`. `docker-compose` is the Compose provider `podman compose` hands the files to,
the same one CI uses; it talks to the root socket enabled above and needs no Docker daemon.
It is the recommended provider. `podman-compose` also works: it has no `up --wait`, so
`update.sh` checks the services' health itself instead.

Podman does **not** restart the stack after a reboot on its own: its `podman-restart.service`
only covers `restart: always`, and the stack uses `unless-stopped`. Step 7 adds a unit for that.

## 3. Network and firewall

### Mode A — one IP

Allow inbound, in the provider's firewall and the host's (if any):

| Port        | Protocol  | For                                                                 |
| ----------- | --------- | ------------------------------------------------------------------- |
| 22          | TCP       | SSH — not the stack's, but yours; restrict it to your IP if you can |
| 80          | TCP       | Let's Encrypt HTTP-01 challenge, redirect to HTTPS                  |
| 443         | TCP       | REST API, MCP, `/healthz`                                           |
| 5060        | UDP + TCP | SIP for trunks and allowlisted desk phones                          |
| 5061        | TCP       | SIP over TLS                                                        |
| 10000–10200 | UDP       | RTP; use your own range if you set `RTP_PORT_START`/`RTP_PORT_END`  |

Leave outbound open: the stack reaches Let's Encrypt, your SIP trunk, your mail relay and your
backup target.

Two things that catch people out:

- **Docker bypasses ufw and plain nftables INPUT rules** for published ports: they are forwarded
  through Docker's own chains. A host-level "deny" does not close them; the provider's firewall
  or the `DOCKER-USER` chain does.
- **Don't forget SSH.** A provider firewall that blocks everything not listed locks you out of
  the host the moment it is applied.

To go TLS-only, set `SIP_UDP_ENABLED=false` and/or `SIP_TCP_ENABLED=false` in `.env` (step 5) and
drop the matching 5060 rule.

### Mode B — one IP per stack

You need a block of public addresses routed to an interface on the host. The example is a Hetzner
dedicated server with a vSwitch; any provider that routes a subnet to you works the same way.

1. **Order the addresses.** In Hetzner Robot, order a public IPv4 subnet (a /27 holds about 30
   stacks; its first usable address is the gateway) and route it to a vSwitch. Note the VLAN id
   (4000–4091).
2. **Bring up the VLAN interface**, MTU 1400 and no address of its own. With systemd-networkd:

   ```ini
   # /etc/systemd/network/10-vswitch.netdev
   [NetDev]
   Name=vlan4000
   Kind=vlan
   MTUBytes=1400
   [VLAN]
   Id=4000

   # /etc/systemd/network/20-uplink.network — add to the physical interface's existing unit
   [Network]
   VLAN=vlan4000

   # /etc/systemd/network/30-vswitch.network
   [Match]
   Name=vlan4000
   [Link]
   MTUBytes=1400
   ```

   Then `networkctl reload`.

3. **Create the `public` network once**, with the block's first address as gateway:

   ```bash
   # Docker
   docker network create -d macvlan --subnet 203.0.113.32/27 --gateway 203.0.113.33 \
     -o parent=vlan4000 public
   # Podman
   podman network create -d macvlan --subnet 203.0.113.32/27 --gateway 203.0.113.33 \
     -o parent=vlan4000 --interface-name vlan4000 public
   ```

Each stack's address is public and untranslated, and no host firewall sits in front of it. The
ports it answers on are exactly those of the Mode A table; `SIP_UDP_ENABLED` and `SIP_TCP_ENABLED`
are how such a stack goes TLS-only. The host cannot reach a stack's address from its parent
interface (a macvlan property), so check a stack from outside.

## 4. DNS

Point an **A record** for the stack's name (`FQDN`) at its address — the host's in mode A, the
stack's `STACK_IPV4` in mode B — before the first start, since Caddy asks Let's Encrypt for the
certificate right away. Add no AAAA record: the stack listens on IPv4 only.

## 5. Get the files and fill in `.env`

One directory per stack (here `/srv/zamfono`), holding the newest release's bundle:

```bash
mkdir -p /srv/zamfono && cd /srv/zamfono
curl -fsSL https://github.com/zamfono/pbx/releases/latest/download/zamfono-deploy.tar.gz \
  | tar xz --strip-components=1
```

For one particular release, replace `latest/download` with `download/vX.Y.Z`.

To check a download, save it to a file instead of piping it into `tar`. Each release lists the
archives' checksums in `SHA256SUMS`, which needs nothing beyond coreutils:

```bash
base=https://github.com/zamfono/pbx/releases/latest/download
curl -fsSLO "$base/zamfono-deploy.tar.gz" && curl -fsSLO "$base/SHA256SUMS"
sha256sum -c --ignore-missing SHA256SUMS
tar xzf zamfono-deploy.tar.gz --strip-components=1
```

That proves the file arrived intact. Each release also carries a signed attestation that the
archives were built by this repository's release workflow at that tag, which proves where they
came from. Checking it needs GitHub CLI 2.49 or newer, logged in (`gh auth login`), so it is
usually easiest on your own machine, against the same file:

```bash
gh attestation verify zamfono-deploy.tar.gz --repo zamfono/pbx
```

On the server itself, Debian 13's own `gh` (2.46) has no `attestation` command; GitHub's
repository has a current one (<https://github.com/cli/cli/blob/trunk/docs/install_linux.md>).

The bundle's `compose.yaml` pulls the images of its own release. Leave `ZAMFONO_VERSION` in `.env`
empty to keep it that way; set it only to follow something else, such as `edge` for testing.

Then run the setup, which asks for everything only you know, generates every secret, hashes the
owner's password with the `api` image, writes `.env` readable by root only, and warns about DNS,
busy ports, Docker's userland proxy or a missing `public` network:

```bash
./setup.sh
```

It uses dialogs where `whiptail` is installed (as on every Debian and Ubuntu) and plain prompts
elsewhere, or with `SETUP_PLAIN=1`. It never overwrites an `.env` that holds values. For automation,
every answer can come from the environment under its `.env` name, plus `ZAMFONO_MODE`
(`ports`/`macvlan`) and `OWNER_PASSWORD`; `SETUP_NONINTERACTIVE=1` makes a missing one an error
instead of a question. The header of `setup.sh` lists them.

### Or by hand

```bash
cp .env.example .env
```

Set the address for your mode — exactly one of the two:

```bash
EXTERNAL_IPV4=198.51.100.7    # mode A: the host's public address; STACK_IPV4 stays empty
STACK_IPV4=203.0.113.34       # mode B: this stack's address in the block; EXTERNAL_IPV4 stays empty
```

Generate the secrets:

```bash
openssl rand -base64 32                       # JWT_SECRET
printf '1:%s' "$(openssl rand -base64 32)"    # SECRETBOX_KEY
openssl rand -hex 24                          # ARI_PASSWORD, and again for AMI_PASSWORD
openssl rand -hex 24                          # BACKUP_PASSWORD, and again for UPDATER_TOKEN
```

**Keep a copy of `.env` outside the host.** `SECRETBOX_KEY` is the only way to read the encrypted
columns; a backup of the database is useless without it. `BACKUP_PASSWORD` opens the local backups:
with it set, the stack backs up every night to the `backups` volume on this host from its first
start. That covers a broken database or a bad upgrade, not a lost host: add a target elsewhere
(`backups.targets.create`) before you rely on the stack.

Fill in `FQDN`, `COMPANY_NAME`, `MAIN_DID`, `COUNTRY`, `BOOTSTRAP_OWNER_EMAIL`,
`BOOTSTRAP_OWNER_NAME`, `CONTAINER_SOCKET` (`/var/run/docker.sock`, or `/run/podman/podman.sock`
on Podman) and, if you have one, the mail relay (`SMTP_*`, `MAIL_FROM`). The comments in
`.env.example` explain each value.

The owner's password hash comes from the `api` image itself, so you never type a password into a
file:

```bash
read -rs PW && printf '%s' "$PW" | docker compose run --rm --no-deps -T api node hash-password.mjs
```

Put the result in `.env` **in single quotes**. An Argon2id hash contains `$`, and Compose reads an
unquoted `$` as a variable reference — the hash arrives with pieces missing and the owner can never
log in:

```bash
BOOTSTRAP_OWNER_PASSWORD_HASH='$argon2id$v=19$m=65536,p=4,t=3$...'
```

Leave it empty instead and the owner gets a set-password mail, which needs `SMTP_HOST`.

## 6. Start it

```bash
docker compose -f compose.yaml -f compose.ports.yaml up -d      # mode A
docker compose -f compose.yaml -f compose.macvlan.yaml up -d    # mode B
```

`migrate` applies the schema and exits; `api` starts on its success, `core` once `api` is healthy.
The first boot seeds the owner, the settings, `MAIN_DID`, nine parking slots and the bundled hold
music, and never seeds again. Check it, from outside in mode B:

```bash
curl -fsS https://<your FQDN>/healthz
```

If it fails, `docker compose -f compose.yaml -f <overlay> logs proxy api` shows whether the
certificate or the application is the problem; a certificate failure is almost always DNS or
port 80.

## 7. Podman only: start the stack at boot

`setup.sh` offers to install this unit, named after the stack directory, and then prints the
`systemctl` commands to start, stop and inspect the stack through it. By hand, one unit per
stack directory (here `/srv/zamfono`; mode A shown):

```ini
# /etc/systemd/system/zamfono.service
[Unit]
Description=Zamfono stack
Wants=network-online.target
After=network-online.target podman.socket
Requires=podman.socket

[Service]
Type=oneshot
RemainAfterExit=true
WorkingDirectory=/srv/zamfono
ExecStart=/usr/bin/podman compose -f compose.yaml -f compose.ports.yaml up -d
ExecStop=/usr/bin/podman compose -f compose.yaml -f compose.ports.yaml down

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable zamfono.service
```

## 8. Upgrading

Run a backup first (`backups.runs.start`, `POST /backups/runs`). Then, in the stack directory:

```bash
cd /srv/zamfono
./update.sh            # the latest release; ./update.sh 0.0.7 for one in particular
./update.sh --check    # only say what an update would do
```

It downloads the release's bundle, checks it against the release's `SHA256SUMS`, unpacks it over
the stack directory (never touching `.env`), adds the settings a newer `.env.example` introduced
that it can generate, and lists the others, pulls the images and recreates the stack: on Podman
through the boot unit of step 7 if there is one, otherwise removing `proxy` first. It then waits
up to three minutes for every service to report healthy. It refuses an older release. A breaking one (a new minor while 0.x, a new major from 1.0.0 on) shows the release
notes in between and asks first; `--yes` answers for a run without a terminal.

A stack from `v0.0.5` or earlier has no `update.sh` yet. Take it, and its helpers, from the newest
bundle once, then run it:

```bash
curl -fsSL https://github.com/zamfono/pbx/releases/latest/download/zamfono-deploy.tar.gz \
  | tar xz --strip-components=1 zamfono/update.sh zamfono/setup
./update.sh
```

**From an MCP client or the API**, the owner updates without a shell: `system.info` shows the
latest release, whether it can be installed this way, and how the last update went, and
`system.update` installs it. It runs the same `update.sh` in the `updater` service, only to a newer
release that is not breaking, and only once a backup run finished `ok` within the last hour. The
updater needs `UPDATER_TOKEN` and `CONTAINER_SOCKET` in `.env`, which `setup.sh` and `update.sh`
write.

**By hand**, the steps `update.sh` takes are: unpack the new bundle over the stack directory, then
pull and recreate with the same overlay as always:

```bash
curl -fsSL https://github.com/zamfono/pbx/releases/latest/download/zamfono-deploy.tar.gz \
  | tar xz --strip-components=1
docker compose -f compose.yaml -f <overlay> pull
docker compose -f compose.yaml -f <overlay> up -d
```

**Podman** refuses to replace `asterisk` while `proxy` still shares its network namespace, so
`up -d` after a pull fails with "has dependent containers which must be removed before it".
Remove the containers first — `down` keeps every volume — or, with the boot unit of step 7,
restart it, which does the same:

```bash
podman compose -f compose.yaml -f <overlay> pull
systemctl restart zamfono.service    # or: podman compose ... down && podman compose ... up -d
```

A unit installed by `v0.0.3` or earlier stops with `stop` rather than `down`; switch it once:

```bash
sed -i 's/ stop$/ down/' /etc/systemd/system/zamfono.service && systemctl daemon-reload
```

Read the new release's **Upgrade notes** in `CHANGELOG.md`, which the bundle holds and the release
page shows: anything an upgrade needs beyond these commands is there. Compare the new
`.env.example` with your `.env`: a release that adds a setting adds it there, and `update.sh`
names the ones it did not fill in. If you set `ZAMFONO_VERSION` in `.env`, `update.sh` changes it
to the new release; by hand, change it yourself.

Migrations only go forward. A bad release is undone by restoring the snapshot the upgrade began
with ([`docs/guide/restore.md`](https://github.com/zamfono/pbx/blob/main/docs/guide/restore.md)) and unpacking the previous release's
bundle (`download/vX.Y.Z`) before `up -d`.

Always `up -d` the whole stack, never `asterisk` alone: `proxy` lives in `asterisk`'s network
namespace, and a recreated `asterisk` leaves it on the old one.

## Logs

`compose logs <service>` reads the running container's own log, and an upgrade recreates every
container. Where that log survives depends on the runtime's log driver:

- **Podman** on a systemd host logs to the journal (`podman info --format '{{.Host.LogDriver}}'`
  says `journald`), which outlives the container. Read an earlier container's log by its name, as
  `podman ps` shows it:

  ```bash
  journalctl CONTAINER_NAME=zamfono-core-1 --since yesterday
  ```

- **Docker** keeps a container's log in a file it deletes with the container, so a log from before
  the last upgrade is gone. To keep them, make the journal Docker's default log driver; containers
  created from then on, on the next `up -d` or upgrade, log there, and `journalctl` reads them as
  above:

  ```bash
  echo '{ "log-driver": "journald" }' > /etc/docker/daemon.json   # merge by hand if the file exists
  systemctl restart docker
  ```

`compose.yaml` names no log driver itself: a host without journald could then start no container.
The journal survives a reboot only where it is persistent, which it is when `/var/log/journal`
exists.

## Next

Connect an MCP client and read [`docs/guide/`](https://github.com/zamfono/pbx/blob/main/docs/guide) — both are described in the
[top-level `README.md`](https://github.com/zamfono/pbx/blob/main/README.md), along with what to settle before you go live: emergency
calls, recording consent and backups.
