# Changelog

What changes for the people who run a Zamfono stack, release by release. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions follow
[Semantic Versioning](https://semver.org/) as `RELEASING.md` applies it. Each release's section is also its GitHub release's
description, and ships in its bundle next to `compose.yaml`.

**Upgrade notes** say what to do beyond deploy/README.md step 8's usual upgrade; a release
without them needs nothing else. The specification's own change log (`docs/spec-changes.md`) records
why the specified behaviour changed; the commit history, how.

## [Unreleased]

### Added

- Help topics `numbers`, `webhooks`, `mail-templates`, `parking`, `user-groups`, `directory` and
  `call-data` (`zamfono.help`, and `reference/<topic>.md` in the Claude Code skill). `numbers`:
  DIDs, number blocks of both kinds, a fixed digit count after the base or open-ended, the main
  number, the block and tenant-wide fallbacks and the most precise match, with a worked example
  of a German PBX line (Anlagenanschluss). `webhooks`: every event and its payload, the event-type
  filter and the `active` switch, retries, timeouts and the delivery status, and how to verify
  `X-Zamfono-Signature`, with code. `mail-templates`: the four kinds, builtin and tenant templates
  per language, the Handlebars subset, the placeholders each kind offers and requires, the test
  send and mail without a relay. `parking`: the slot extensions, park, retrieve, the ring-back to
  the parker and BLF on slots. `user-groups`: where they are used, nesting, flattening and
  deletion. `directory`: the phone book, how it names callers, and the search. `call-data`:
  voicemails and MWI, the presence history and its snapshot, and the call statistics. The
  glossary, `mental-model` and `routing-order` point to them.

### Changed

- MCP clients and the OpenAPI document now describe what an operation's input fields mean, not
  just their names and types: every tool's input schema carries a one-sentence `description` per
  field whose meaning is not obvious, and terse tool descriptions say what the operation does.
- `zamfono.help` with an unknown topic still fails with 404, but its message now lists every
  topic; `index` lists them like a call without a topic, and the server instructions say so.
- Webhook deliveries survive a restart of `api`: an event still queued, or waiting for its retry,
  when `api` restarts (an update, a crash) is delivered after it, with the attempts it has left,
  where it used to be lost. Deleting a webhook drops its pending deliveries. A delivery cut off
  mid-request is sent again, so receivers keep deduplicating on the event `id`.
- The specification now says exactly when a webhook's `lastStatus` turns `failing`: as soon as
  one delivery has failed all three attempts; the next delivery that succeeds turns it back to
  `ok`. Delivery itself is unchanged.

### Fixed

- Claude Code could not connect to any Zamfono stack: its sign-in page showed "Something went
  wrong while signing in." Claude Code receives the sign-in result on `localhost` at a port it
  picks anew each time, and the stack accepted such a port only from clients registered as
  `native` and only on `127.0.0.1`. A redirect to `localhost`, `127.0.0.1` or `[::1]` over
  `http` is now accepted on any port, for every client, when the client registered that host
  and path; any other redirect URI must still match exactly.
- The time filters of `presenceLog.snapshot` (`at`), `calls.list` and `audit.list` (`from`,
  `to`) compared the text they were given with the stored UTC times, so a time with an offset
  (`2026-10-01T12:00:00+02:00`) or without milliseconds picked the wrong entries. They now
  compare the instant it names, in any offset, with a time without one read as UTC; a value
  that is not an ISO 8601 time or date is refused with 422.
- `system.info` reported the last update the `updater` service ran, not one run with `update.sh`
  on the host. `update.sh` now records its run in `.update/state.json` as the updater does,
  `running` while it runs and then `succeeded` or `failed` with both versions and times, and
  `system.info` shows it; `update.sh --check` records nothing.

## [0.1.0] - 2026-09-30

### Added

- Users set their own call forwarding: `users.setForwarding` (`PUT /users/{id}/forwarding`) is
  self-service on a user's own account, refused with 403 for anyone else's, and audited under the
  user's name; admins still set anyone's. They read them with the new `users.getForwarding`
  (`GET /users/{id}/forwarding`), on the same terms, in the shape the `PUT` takes, so a client
  reads, edits and sends them back. A user may forward to anything they can already use
  elsewhere, but not to a new `sip` target: a rule an admin set to one is kept as it is if the
  user sends it back unchanged under the same condition, refused if they change it or move it to
  another condition, and removed if they leave it out, since the call replaces the rules as a
  whole. An external forward is dialled as the user's own call, so a number their outbound routes
  do not carry is stored but refused when a call is forwarded.
- A trunk setting `diversion` (`trunks.create`, `trunks.update`, `POST /trunks`,
  `PATCH /trunks/{id}`) decides whether a call the stack forwards out over the trunk, to an
  external number or a `sip` target, tells the far end who forwarded it: `off`, the default and
  what every existing trunk gets, sends nothing, as before; `last` sends one `Diversion` entry,
  the user or ring group whose rule forwarded the call last; `all` one entry per forward, newest
  first. Each entry names the forwarding user's own number, a ring group's own DID, or else the
  company's main number, never an internal extension, with the reason (`unconditional`,
  `user-busy`, `no-answer`, `unavailable`, `do-not-disturb`, `away` for out-of-office,
  `time-of-day` for closed hours). Some carriers show the original caller's number on a
  forwarded call only when a `Diversion` names one of the company's numbers; an AI agent behind
  a `sip` target learns from it who forwarded the call and why.
- A trunk setting `qualify` (`trunks.create`, `trunks.update`, `POST /trunks`,
  `PATCH /trunks/{id}`), on unless given: with it off, the stack stops sending an `ip` trunk's
  provider the OPTIONS request it checks reachability with every 60 seconds, for an endpoint that
  never answers one, such as possibly OpenAI's Realtime SIP endpoint, and so showed `unreachable`
  and had every call to it skipped. Such a trunk reports the new status `unmonitored`
  (`trunks.get`, `GET /trunks`, the `trunk.status` event), is always tried, and fails over only
  when a call over it fails; `zamfono_trunk_registered` in `/metrics` has no line for it.
  `qualify` has no effect on a `registration` trunk, whose status is its registration's. Existing
  trunks keep `qualify` on.
- A call's QoS rows (`calls.get`, `GET /calls/{id}`, at diagnostics level `qos`) count each
  leg's RTP packets, `rxPackets` received from its far end and `txPackets` sent to it. An answered
  leg with `rxPackets: 0` received no audio at all from that side, typically a phone behind NAT
  or a firewall, or one announcing a wrong address in its SDP; before, it read as "nothing
  measured", the same as a phone that sends no RTCP. The recipe `diagnose-bad-call` explains what
  to check. Calls recorded before the upgrade have no counts (`null`).
- A forward target of a new kind, `sip`, `{ "kind": "sip", "trunkId": "…", "user": "proj_…" }`,
  sends a call to a SIP address rather than a phone number: the stack dials `user` at the trunk's
  own hosts, such as OpenAI's Realtime SIP endpoint at `sip.api.openai.com`, with no outbound route
  involved. It works wherever a target does (DIDs, forwarding and out-of-office rules, opening
  hours, ring-group fallbacks, menus, the tenant fallback), and a ring-group member's unconditional
  forward to one rings as the member's leg. Only admins and owners set one; a user editing their own
  out-of-office rule or opening hours is refused for it. A trunk a `sip` target dials over cannot be
  deleted until the target is changed: `trunks.delete` (`DELETE /trunks/{id}`) answers 409 listing
  where it is used. A `sip` target also names the SIP headers its call carries,
  `"headers": [{ "name": "X-Called", "value": "{{calledExtension}}" }]`: each name starts with `X-`,
  and each value is text with `{{placeholder}}`s for the original caller and their name, the company
  number dialled, the user or ring group the call was for, who forwarded it last and why, the number
  of forwards, the call's id, direction, language and start time. A header whose value comes out
  empty, such as the caller's number when they withheld it, is left out. Without `headers` a target
  sends `X-Zamfono-Caller: {{callerNumber}}` and `X-Zamfono-Did: {{did}}`; `[]` sends none. A value
  with an unknown placeholder, a name given twice or headers larger than 2048 bytes are refused, and
  headers that could make the call's INVITE too large for a UDP trunk are accepted with a warning.
  The recipe `forward-to-ai-agent` walks through the OpenAI setup.
- The stack serves the Zamfono logo as its favicon (`/favicon.ico`, `/favicon.svg`) and in a
  light and a dark variant (`/logo.svg`, `/logo.png`, `/logoDark.svg`, `/logoDark.png`), and the
  MCP server names itself with it: MCP clients that show a server's icon, title or website now show
  Zamfono's.
- `system.info` (`GET /system/info`) shows the stack's domain and the public IPv4 address its
  phones, trunks and audio use, as `stack.domain` and `stack.ipv4`: the `FQDN` and the
  `EXTERNAL_IPV4` or `STACK_IPV4` of `.env`, whichever the stack's network mode sets. Nothing in
  `.env` changes; an update brings the new `compose.yaml` that hands the address to `api`.
- Two trunk settings for providers reached over TLS (`trunks.create`, `trunks.update`,
  `POST /trunks`, `PATCH /trunks/{id}`): `tlsVerify` checks the provider's certificate against
  the public certificate authorities and its name against the host dialled, and a connection
  that fails the check is closed; `srtp` encrypts the trunk's media (SDES-SRTP), which some
  providers require. Both apply to a trunk whose `transport` is `tls`; `srtp` is refused on any
  other. A new trunk has `tlsVerify` on and `srtp` off. Existing TLS trunks keep working
  unchanged: they get `tlsVerify` off, as nothing checked their certificate before, and can be
  switched on once the provider presents a publicly trusted one. Trunks with `tlsVerify` off
  connect from a second TLS listener on port 5062, which only makes outgoing connections: in the
  ports mode it is not published, and in the macvlan mode, where Asterisk has an address of its
  own, a host firewall need not open it.

### Changed

- A backup run shows two sizes instead of one: `bytesTotal`, the full size of its snapshot, and
  `bytesAdded`, what it uploaded after restic's deduplication. The run's `bytes` field is gone
  from `backups.runs.list` and `backups.runs.get` (`GET /backups/runs`, `GET /backups/runs/{id}`)
  and from the `backup.finished` event on `/events` and webhooks; it held what is now
  `bytesAdded`, which is why a run far smaller than the one before it looked incomplete. Runs from
  before the upgrade keep that value as `bytesAdded`, with no `bytesTotal`.
- `call_qos` also draws on the RTCP reports Asterisk mirrors to `core`: a leg's packet loss or
  round trip that Asterisk's own summary at hangup left unmeasured is taken from them, and a leg
  whose hangup event was lost, while the connection to Asterisk was down, still gets its row. This
  works at every diagnostics level while `HEP_ENABLED` is on, the default; with it off, the rows are
  as before.

### Fixed

- A change to the apps' language that Ringotel refused was dropped once any later Ringotel change
  (a user or extension change, or the re-registration after a restart) went through: those carry
  the connection's profile but not the organization's language, and still marked the profile as
  delivered, so `system.info` and `/healthz` no longer showed it pending and it was never sent
  again. The profile now stays pending until Ringotel has taken all of it, and the stack sends it
  again when `api` starts, when Asterisk restarts or with the next change to the apps' profile.
- A call's `sip`-level log listed Asterisk's RTCP reports, JSON lines such as
  `{"ssrc":…,"type":200,…}`, as if they were SIP messages, close to half the lines of a call
  with audio. The log now holds the call's SIP messages only.
- A call answered at the very moment its ring time ran out could go to voicemail (or the
  `noAnswer` forward) while the answering phone stayed connected to nothing, until the caller hung
  up. The same could happen when a phone answered just as another of the user's phones declined,
  or just before its own ringing was confirmed on a busy host. The phone that answers first now
  always gets the call, and a phone answering after the ring has already moved on is hung up. A
  click-to-dial could also send its target straight to voicemail, without ringing it, when one of
  the user's own phones was slow to be reached after another had answered. A ring group's batch
  timing out as a member answered had the same fault, the caller moving on to the next members or
  the fallback, and a member answering after its batch had timed out could still take the call.
- An external leg (a find-me number, or a ring group member forwarded to an external number) that
  answered at the moment its 8-second wait for a first response from the provider ran out could
  be hung up although it had answered.

### Upgrade notes

- **Anything that reads a backup run's `bytes`**, such as a monitoring script, an MCP client's
  prompt or a webhook receiver for `backup.finished`, has to read `bytesAdded` instead for the
  same value, or `bytesTotal` for the snapshot's size: `bytes` is no longer sent. This makes the
  release a breaking one, so `update.sh` shows these notes and asks first, and `system.update`
  does not install it.

## [0.0.7] - 2026-09-30

### Fixed

- Changing the emergency numbers, or any setting the Ringotel apps' profile carries (codecs,
  feature codes, registrations per user, country, language), failed while Ringotel was
  unreachable, and the PBX did not get the new numbers either. The change is now stored and in
  force on the PBX at once; Ringotel gets it afterwards, and if Ringotel refuses, the result warns,
  the audit log records it, `system.info` and `/healthz` show the profile as pending, and the stack
  sends it again with the next Ringotel change, when `api` starts or when Asterisk restarts.
- A phone rang for at most 30 seconds, however long the user's ring timeout or the ring group's
  timeouts were set, and an outbound call the far end had not answered within 30 seconds was cut
  off. Rings now last as long as they are set to, and an outbound call rings until it is answered
  or refused.
- A user's second and further phones, and a ring group's members, started ringing one after the
  other, each up to a few seconds after the one before. They now all ring at once.
- A leg with one-way audio, whose far end sent nothing back, read a packet loss of 0 % in
  `call_qos`, a perfect line. Its loss now reads as not measured.
- Editing a running out-of-office rule's end or start, or a rule that follows another back to
  back, sent no `ooo` event, so the live status kept the old end time. It now updates at once.
- The `ooo` and `hours` events, and the live OOO and opening-hours status they drive, came up to
  a minute after a rule started or expired or the opening hours opened or closed, and after the
  rules were changed. They now go out at the moment itself, and at once after a change.
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
  before Ringotel is set up now says so in a `warnings` entry instead of nothing. Setup and
  adoption, which provision such a device, add its `ringotel.push` entry too; a device Ringotel
  refuses there is a `warnings` entry of theirs rather than failing the whole setup.
- The call log's `sip` level recorded no SIP message at all: Asterisk refused its collector
  address `core:9060`, since it takes a numeric address only, and mirrored nothing. It now sends
  to the address `core` has, and follows it when `core` is recreated.
- Every device registration was lost whenever the containers were recreated, as an update does,
  and a phone stayed unreachable until it registered again. Registrations over UDP now survive;
  those over TLS or TCP, the Ringotel apps' among them, end with any Asterisk restart, which
  prunes them at start: such devices register again, and the apps are told to at once.
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
- `system.info` waited as long as a hung `core` took to report its version. It now gives up after
  three seconds and shows `core` as `null`.
- `update.sh` on Podman without the boot unit, with `podman-compose` as the provider of
  `podman compose`, stopped after installing the new files and left the old containers running:
  `podman-compose` has no `rm` for removing `proxy`. Without the unit, `update.sh` now takes the
  stack `down` before `up -d` on Podman. A rerun, which said "Already on" the new release, now
  finishes an update that stopped before its stack reported healthy.
- Undoing the deletion of a `ringotel` device, or of its user, pushed the device to Ringotel
  inside the undo, before Asterisk held it again, so Ringotel could refuse the app's registration
  and a refusal failed the undo. The push now follows the undo as a device creation's does: a
  refusal is a `warnings` entry, and the outcome a `ringotel.push` audit entry (trigger
  `audit.undo`).

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
  callee or the system) with the cause, and a leg Asterisk could not place (`placementFailed`),
  which counts as one that ended at once. The `diagnose-bad-call` recipe lists the lines.

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

- **Ringotel connections change at their next push**: the first user, extension, ring-group,
  parking or profile change after the upgrade, or the upgrade's own restart (which re-registers
  the apps), rewrites the connection's settings; a device change does not. Internal calls then
  always go through the PBX, the PBX's caller name wins over the app's contacts, apps stay
  registered while closed and re-register every two minutes, and the mobile apps dial emergency
  numbers over the cellular network. Settings changed by hand in the Ringotel Shell for these are
  overwritten.
- The `astdb` volume is created by the upgrade's own `up -d`; nothing to do. It starts empty, so
  phones registered over UDP register again after this one upgrade; those over TLS or TCP do so
  after every restart anyway, the Ringotel apps at once.

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

[Unreleased]: https://github.com/zamfono/pbx/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/zamfono/pbx/compare/v0.0.7...v0.1.0
[0.0.7]: https://github.com/zamfono/pbx/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/zamfono/pbx/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/zamfono/pbx/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/zamfono/pbx/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/zamfono/pbx/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/zamfono/pbx/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/zamfono/pbx/compare/v0.0.0...v0.0.1
[0.0.0]: https://github.com/zamfono/pbx/releases/tag/v0.0.0
