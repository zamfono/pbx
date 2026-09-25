# Manual NAT / device checklist

Spec §8 "Testing Strategy" calls for this alongside the automated suites: the sipp scenarios
under `test/integration/` exercise routing logic against a stack and simulated phones on one
network, which proves nothing about a real device crossing real NAT. Run this by hand against a
live stack whenever the SIP transports, NAT settings or endpoint rendering change — §9.1
(`pjsip.conf`/`rtp.conf` transports), §9.3 (per-device NAT settings), or the renderers at
`packages/api/src/lib/pjsip/` and the templates at `images/asterisk/conf/*.tmpl`.

## Setup

- A stack reachable at its FQDN, on either overlay (`compose.ports.yaml` or
  `compose.macvlan.yaml`, §6.2).
- One test user with two devices (`POST /users/{id}/devices`, §9.3): one `tls` (registers from
  anywhere) and one `plain` (needs `allowedIps` set to the office's public address).
- `SIP_UDP_ENABLED` and `SIP_TCP_ENABLED` at their default `true`, so the `plain` device's
  transport is actually open (§9.1).
- A softphone from `docs/guide/tested-softphones.md`, or any standards-compliant SIP client
  configured by hand with the credentials the device endpoint returned.

## Every environment: what to check

- [ ] The device registers within a few seconds of starting it, and again within about a minute
      of a network change (Wi-Fi ↔ cellular, sleep/wake) without being restarted by hand —
      `rewrite_contact=yes` (§9.3) is what should let a changed source IP/port keep the same
      registration.
- [ ] An inbound call rings the device and, once answered, audio flows both ways.
      `rtp_symmetric=yes` and `direct_media=no` (§9.3) mean every RTP packet transits Asterisk;
      one-way or absent audio here is NAT traversal failing for that path.
- [ ] An outbound call from the device connects and has two-way audio.
- [ ] Hold and resume: the held party's audio stops and resumes correctly.
- [ ] Blind and attended transfer, started from the device's own SIP transfer, both succeed.
- [ ] Where the device carries a BLF panel, it updates within a few seconds of a colleague's
      state changing (§9.3, "BLF and presence").
- [ ] A voicemail left for the device's user sets its MWI indicator.
- [ ] `*8<ext>` directed pickup, dialled from this device, answers a call ringing elsewhere in
      the tenant (§9.3, feature codes).

## Office

Desk phone or softphone on the office LAN — the case a `plain` device is meant for.

- [ ] A `plain` device registers only once its address is on `devices.allowedIps`; removing the
      address and reloading (`PATCH /devices/{id}`) makes the same device stop registering.
- [ ] With `SIP_UDP_ENABLED` and `SIP_TCP_ENABLED` both set to `false`, creating a new `plain`
      device is refused by the API, and an existing `plain` device stops registering — its
      transport is now bound to `127.0.0.1` (§9.1, §9.3).
- [ ] A `tls` device on the same LAN registers and behaves identically to one from elsewhere.

## Home office

Softphone on a home network, no VPN or remote-access client — the setup the target profile names
as normal (§1), and what `docs/guide/remote-workers.md` tells a remote worker to expect.

- [ ] A `tls` device registers over TLS:5061 with no port forwarding or VPN configured on the
      home router, and every "Every environment" check above passes unchanged from this network.
- [ ] A `plain` device does **not** register from home unless its home address was deliberately
      added to `allowedIps` — this confirms the allowlist actually restricts it, not merely that
      TLS works.

## Mobile network

Softphone app on a phone, on the carrier's cellular data, off Wi-Fi — typically behind
carrier-grade NAT and, on some carriers, a public IP that changes over the session.

- [ ] A `tls` device registers on cellular data alone, and every "Every environment" check above
      passes on that connection.
- [ ] Switching mid-call between Wi-Fi and cellular does not drop the call outright; note
      whether audio glitches or recovers. `icesupport = yes` (`rtp.conf`) is the only NAT aid
      configured on the media path beyond `rewrite_contact`/`rtp_symmetric`/`force_rport` — there
      is no STUN or TURN server configured — so this is the environment most likely to expose a
      NAT a session can't traverse; record whatever happens rather than assuming it will recover.
- [ ] Backgrounding the app for several minutes, then calling its user's extension, still rings
      it. Push wake-up is the softphone vendor's own concern (§9.3), so this only checks that the
      SIP side still reaches the app once it wakes.

## Recording the result

Next to each checked box, note the device/app and its version, the network (ISP or carrier), and
the date. Keep results with the release they were run against. A failure here is a NAT/transport
bug even when every automated suite is green — closing that gap is why this checklist exists
(§8).
