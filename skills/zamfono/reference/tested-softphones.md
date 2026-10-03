# Tested bring-your-own softphones

The `manual` provisioning provider works with any SIP softphone or desk phone: `devices.create`
(`POST /users/{id}/devices`) returns the device's `connectionSettings` once, and they are entered
into the client by hand. `devices.revealCredentials` (`GET /devices/{id}/credentials`, admin,
audited) returns the same set later; after `devices.rotate` (`POST /devices/{id}/rotate`) only the
`password` changes.

| Field             | Meaning                                                                    |
| ----------------- | -------------------------------------------------------------------------- |
| `server`          | The stack's FQDN, the SIP server to register with                          |
| `domain`          | The SIP domain, the same FQDN                                              |
| `transport`       | `tls` for a `tls` device; `udp` and/or `tcp` for a `plain` one, use either |
| `port`            | `5061` for `tls`, `5060` for `udp`/`tcp`                                   |
| `username`        | The SIP username, also the authentication username                         |
| `password`        | The SIP password                                                           |
| `extension`       | The user's extension                                                       |
| `displayName`     | The user's name, the caller ID the phone shows                             |
| `mediaEncryption` | `srtp` (SDES-SRTP, mandatory) for `tls`; `none` for `plain`                |
| `codecs`          | The tenant's codecs in order of preference                                 |
| `voicemailCode`   | The feature code that dials the user's own voicemail                       |

No STUN server, ICE or outbound proxy is needed: Zamfono handles NAT itself. A `plain` device
registers only from an address on its allowlist (see `remote-workers`). Two clients are verified
against Zamfono and recommended.

## Groundwire (Acrobits)

- Mobile (iOS/Android). A one-time purchase, no subscription — the recommended no-subscription
  mobile option.
- Vendor-run push notifications, so it wakes for calls without keeping a persistent connection.
- Supports BLF.
- Add a generic SIP account:
  - **Title**: any label; **Username**: `username`; **Password**: `password`;
    **Domain**: `domain`:`port` (e.g. `pbx.example.com:5061`).
  - **Display name**: `displayName`.
  - Advanced settings: **Auth username**: `username`; **SIP transport**: `transport` (TLS, or UDP
    / TCP); **Secure calls (SRTP)**: SDES, mandatory when `mediaEncryption` is `srtp`, off when
    `none`.
  - Leave **Outbound proxy** and STUN empty.
  - **Voicemail number**: `voicemailCode`.
  - Codecs (Wi-Fi and cellular): enable the entries of `codecs` in that order.

## MicroSIP

- Windows desktop only.
- Needs no push, since a desktop client stays connected while running.
- Lightweight, open source, a common choice for a reception desk or an always-on office PC.
- Add an account:
  - **SIP Server**: `server`:`port`; leave **SIP Proxy** empty.
  - **Username** and **Login**: `username`; **Password**: `password`; **Domain**: `domain`.
  - **Display Name**: `displayName`; **Voicemail Number**: `voicemailCode`.
  - **Transport**: `transport` (TLS, or UDP / TCP); **Media Encryption**: Mandatory when
    `mediaEncryption` is `srtp`, Disabled when `none`.
  - Leave STUN and ICE off.
  - Settings, Codecs: enable the entries of `codecs` in that order.

Zamfono provisions nothing client-specific for `manual` devices: any other client is set up from
the same fields.
