# Changelog

What changes for the people who run a Zamfono stack, release by release. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions follow
[Semantic Versioning](https://semver.org/) as `RELEASING.md` applies it. Each release's section is also its GitHub release's
description, and ships in its bundle next to `compose.yaml`.

**Upgrade notes** say what to do beyond deploy/README.md step 8's usual upgrade; a release
without them needs nothing else. The specification's own change log (`docs/spec.md`) records
why the specified behaviour changed; the commit history, how.

## [Unreleased]

### Fixed

- Internal calls between Ringotel apps did not always pass through the PBX, so they could be
  missing from the call history, recordings and presence: the connection kept Ringotel's default,
  "through PBX if possible", since the setting Zamfono sent has no effect. The connection now
  routes every call through the PBX, calls to one's own extension and video calls included, and
  the caller name the PBX sends wins over the app's contacts.
- After an Asterisk restart, a stack restart or an update, the Ringotel apps stayed unreachable
  until their next registration, up to an hour. The stack now has Ringotel re-register every app
  the moment Asterisk is back, and the apps re-register every two minutes anyway.
- What Ringotel answered to a device's push, and the re-registration after a restart, was only in
  the call's result and the container log, which an update discards. Each is now an audit entry
  (`ringotel.push` on the device, `ringotel.rereg`), and a `ringotel` device created or rotated
  before Ringotel is set up now says so in a `warnings` entry instead of nothing.
- The call log's `sip` level recorded no SIP message at all: Asterisk refused its collector
  address `core:9060`, since it takes a numeric address only, and mirrored nothing. It now sends
  to the address `core` has, and follows it when `core` is recreated.
- Every device registration was lost whenever the containers were recreated, as an update does,
  and a phone stayed unreachable until it registered again.
- The `qos` level's `call_qos` rows had no jitter or loss and a round trip of 0, and only the
  caller's leg had one: the core read fields Asterisk does not send, and read the leg that hung up
  after its channel had gone. Each bridged leg now has a row with jitter and round trip in
  milliseconds and loss in percent, a mailbox-answered caller's included, taken from the summary
  Asterisk records on the leg as it hangs up, whichever side hangs up first, so nothing is polled
  while the call runs; what was not measured (a round trip without RTCP, a leg no audio reached)
  is empty rather than 0.
- At the call log's `sip` level, a leg refused at once (a trunk answering 403 within
  milliseconds) recorded none of its SIP messages. Each leg the PBX places now joins the call's
  capture before its INVITE leaves, the user's own phones a click-to-dial or an API pickup rings
  included.
- A call could hang, ringing on for its caller until they gave up, when Asterisk refused to place
  one of its legs, as a loaded host did by answering a leg's dial before the leg was ready. A leg
  that cannot be placed now counts as one that ended at once: the ring goes on with the other
  phones or reaches its fallback, an outbound call tries its next route, and the trace says
  `placementFailed`.
- A pickup over the API (`POST /calls/{id}/pickup`) that went wrong left no trace of why: which
  of the picker's phones rang, declined or could not be reached was written nowhere. The picked-up
  call's own history now carries those lines, as `pickupRing` entries naming each step.
- A ring group change that left its members alone (its strategy, ring timeout, mailbox or
  diagnostics level) did not reach call routing until some other change reloaded the
  configuration; raising a group to `qos` or `sip` had no effect on its calls.
- `lastRegisteredAt` on a device is documented as what it is: when the device last became
  reachable, not its latest registration refresh, which Asterisk reports no event for.
- `/metrics` waited for as long as `core` took to answer its health check, so a hung `core` hung
  the scrape too. It now gives up after three seconds, as `/healthz` does.

### Added

- The Ringotel mobile apps dial the tenant's emergency numbers through the phone's own cellular
  network, reaching the emergency centre where the person is, with the phone's location, even
  without mobile data. Such a call bypasses the PBX: it has no call-history entry and uses no
  emergency trunk. Desktop apps and desk phones still dial them through the PBX's emergency
  trunks. The numbers follow `emergencyNumbers` in `settings.update`.
- `system.info` shows when `api` and `core` started (`startedAt`) and when Asterisk did
  (`core.asteriskStartedAt`), so a restart is visible.
- The call log's routing trace says more: why the user step decided as it did (DND, offline with
  the number of registered phones, a forward) and why a call reached voicemail, the opening hours
  also when none apply, the answering channel with its device or trunk, the codecs both sides
  negotiated, the caller ID each outbound attempt presented, and who ended the call (caller,
  callee or the system) with the cause. The `diagnose-bad-call` recipe lists the lines.

### Changed

- Asterisk keeps its astdb, which holds the device registrations, on a new `astdb` volume.
- `deploy/README.md` says where container logs survive an upgrade (Podman's journal) and how to
  keep them on Docker ("Logs").
- A backup started by hand (`POST /backups/runs`) begins at once, instead of up to five seconds
  later, and `api` stops as soon as the stack is stopped or updated, instead of after Docker's
  ten-second grace period.
- `update.sh` reports an update done once every service is healthy, `core` included, not only
  `api`; it waits up to three minutes, as before. With `podman-compose` as the provider of
  `podman compose`, which cannot wait on healthchecks, it checks `api` and `core` itself.

### Upgrade notes

- **Ringotel connections change at their next push**: the first device, user, extension or
  profile change after the upgrade, or the upgrade's own restart, rewrites the connection's
  settings. Internal calls then always go through the PBX, the PBX's caller name wins over the
  app's contacts, apps stay registered while closed and re-register every two minutes, and the
  mobile apps dial emergency numbers over the cellular network. Settings
  changed by hand in the Ringotel Shell for these are overwritten.
- The `astdb` volume is created by the upgrade's own `up -d`; nothing to do. It starts empty, so
  the registrations of this one upgrade are still lost: devices come back as they re-register.

## [0.0.6] - 2026-09-29

### Fixed

- Calls over a registration trunk whose provider addresses the INVITE to the account name and
  names the dialled number only in `To` (mucpbx among them) were refused with 404. The dialled
  number is now taken from `To` when the Request-URI's is no number, and the routing trace says
  so (`calledFrom: to`).
- The call log's `sip` level recorded nothing for a call refused at once. Such a call now records
  its INVITE, its final response and the ACK, and at the default `events` level the trace names a
  number that matched no DID before the 404.
- A backup to a new target failed on its first run: nothing created the target's restic
  repository. The first run now creates it.
- The Ringotel connection now carries the tenant's country, which the apps use to match callers'
  numbers to contacts, and follows a change of it.
- A `ringotel` device reached Ringotel before Asterisk knew it: Ringotel's test registration
  failed, it created no user and sent no activation e-mail, and `devices.create` still reported
  success. The device now reaches Ringotel once Asterisk holds it, the same for a rotated
  password, and a device Ringotel refuses carries a `warnings` entry naming Ringotel's reason;
  `devices.rotate` pushes it again.
- Every Ringotel refusal reaches the caller with Ringotel's own message instead of an internal
  error, and `provisioning.ringotelSetup` answers a domain the account already has with the
  `provisioning.ringotelAdopt` call that takes it over.
- Ringotel setup and adoption set the registrations per user (`ringotelMaxRegs`) to what the
  package allows, 6 for Pro, while it is still at its default of 3.

### Added

- A `ringotel-setup` help topic (`zamfono.help`): connecting the stack to Ringotel, from the API
  key through setup or adoption to the first device.
- Backups from the first night on: a stack with `BACKUP_PASSWORD` in `.env` creates a `local`
  backup target on the new `backups` volume when it has never had one, and `setup.sh` generates
  the password. It is on the same host, so it covers a broken database or a bad upgrade, not a
  lost host; add a target elsewhere for that.
- `update.sh` in the bundle updates a stack in one command: it downloads the release, checks it
  against `SHA256SUMS`, installs it without touching `.env`, adds the new settings it can
  generate, and recreates the stack the right way for Docker or Podman. A breaking release shows
  its notes and asks first.
- `system.update` (`POST /system/update`) updates from an MCP client or the API: the new `updater`
  service, reachable only inside the stack, runs `update.sh` to a newer, non-breaking release once
  a backup finished within the hour. `system.info` now shows the latest release and how the last
  update went.
- The admin skill's tool list names each tool's REST endpoints, and the guide names each step by
  its MCP tool first, with the REST call beside it (`users.create` (`POST /users`)), so an MCP
  client no longer has to work out which tool a REST call is.

### Changed

- The `api` and `core` images are smaller: they no longer carry the development tooling
  (about 150 MB each), and they share their ffmpeg layer, so a stack pulls it once instead of
  twice.

### Upgrade notes

- **Update with `update.sh`**, which this release introduces. Take it from the bundle once, then
  run it; it adds `BACKUP_PASSWORD`, `UPDATER_TOKEN` and `CONTAINER_SOCKET` to `.env`:

  ```bash
  curl -fsSL https://github.com/zamfono/pbx/releases/download/v0.0.6/zamfono-deploy.tar.gz \
    | tar xz --strip-components=1 zamfono/update.sh zamfono/setup
  ./update.sh 0.0.6
  ```

  Keep the new `BACKUP_PASSWORD` with your copy of `.env`: it opens the local backups.

- **By hand instead:** add `BACKUP_PASSWORD` and `UPDATER_TOKEN` (`openssl rand -hex 24` each) and
  `CONTAINER_SOCKET` (`/var/run/docker.sock`, or `/run/podman/podman.sock` on Podman) to `.env`
  before `up -d`.

## [0.0.5] - 2026-09-29

### Added

- `provisioning.ringotelAdopt` (`POST /provisioning/ringotel/adopt`): takes over a Ringotel
  organization that already exists, created in the Ringotel Shell or left behind by a failed
  setup, instead of creating one. It finds the organization only by its id and its domain
  together, and only while it has no users, so it cannot take over another customer's
  organization; it points the named connection, or a new one, at the stack.
- `provisioning.ringotelOptions` (`GET /provisioning/ringotel/options`): the regions and
  packages the Ringotel account offers, read live.
- `system.info` (`GET /system/info`): the version and commit `api` and `core` each run, for any
  signed-in user, and so for any MCP client.

### Changed

- `provisioning.ringotelSetup` refuses a region or package the account does not offer before it
  creates anything, and names the ones it does.
- The release bundle holds this `CHANGELOG.md`, and each release's description is its section
  here.

## [0.0.4] - 2026-09-29

### Fixed

- Signing in from a browser ended on "Something went wrong while signing in" after
  **Approve**, so connecting Claude as a custom connector failed. The consent cookie now reaches
  the endpoint the page submits the approval to.
- Upgrading a Podman stack failed with "has dependent containers which must be removed before
  it". The boot unit `setup.sh` installs now stops the stack with `down`, so
  `systemctl restart` after a pull recreates it; `down` keeps every volume.

### Upgrade notes

- **Podman with a boot unit from 0.0.3 or earlier:** switch the unit to `down` once, then
  upgrade through it:

  ```bash
  sed -i 's/ stop$/ down/' /etc/systemd/system/zamfono.service && systemctl daemon-reload
  podman compose -f compose.yaml -f compose.ports.yaml pull
  systemctl restart zamfono.service
  ```

## [0.0.3] - 2026-09-29

### Fixed

- MCP clients whose client metadata document has no `application_type`, claude.ai's among
  them, were refused at sign-in as an unknown client; they now count as web clients.
- `setup.sh`'s DNS check read `/etc/hosts`, so a server named after its FQDN seemed to resolve
  to `127.0.1.1`, and it reported an AAAA record for every name that resolved at all.

### Changed

- After installing the Podman boot unit, `setup.sh` prints the `systemctl` commands to start,
  stop and inspect the stack through it.
- deploy/README.md checks a download by its checksum on the server, and its provenance where
  GitHub CLI 2.49 or newer is signed in; Debian 13's own `gh` is too old for that.

### Upgrade notes

- **Podman:** `up -d` after a pull fails with "has dependent containers" (fixed in 0.0.4). Run
  `podman compose -f compose.yaml -f compose.ports.yaml down` first, then `up -d`.

## [0.0.2] - 2026-09-29

### Added

- A release bundle per version: `zamfono-deploy.tar.gz` (and `.zip`) holds the operator files
  of `deploy/`, with `compose.yaml` pinned to that release's images, plus `SHA256SUMS` and a
  signed build-provenance attestation.
- deploy/README.md: from a blank host to a running stack, for one IP or one IP per stack, on
  Docker or Podman, firewall rules included.
- `setup.sh`: writes a first `.env`, asking for what only the operator knows, generating every
  secret and hashing the owner's password, and never overwrites an `.env` that holds values.

### Upgrade notes

- A stack that copied `deploy/` from the repository can switch to the bundle: unpack it over the
  stack directory, which keeps `.env`, and leave `ZAMFONO_VERSION` empty so the stack follows
  the bundle's own release.

## [0.0.1] - 2026-09-28

### Changed

- Emergency calls go out only over trunks flagged `emergency`, still in trunk order. With none
  flagged they fail with 503, a write that leaves none flagged warns, and `/healthz` reports it.
- Trunks send the provider only the presented number, never the extension a call was bridged
  to.

### Upgrade notes

- The upgrade flags every existing trunk `emergency`, as each carried emergency calls before.
  Unflag any that should not, such as a trunk in another country than the company.
- `POST /trunks` now requires `emergency`; an integration that creates trunks must send it.

## [0.0.0] - 2026-09-25

The first tagged version, before any deployment.

[Unreleased]: https://github.com/zamfono/pbx/compare/v0.0.6...HEAD
[0.0.6]: https://github.com/zamfono/pbx/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/zamfono/pbx/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/zamfono/pbx/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/zamfono/pbx/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/zamfono/pbx/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/zamfono/pbx/compare/v0.0.0...v0.0.1
[0.0.0]: https://github.com/zamfono/pbx/releases/tag/v0.0.0
