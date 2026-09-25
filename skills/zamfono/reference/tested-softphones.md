# Tested bring-your-own softphones

The `manual` provisioning provider works with any SIP softphone or desk phone: `POST
/users/{id}/devices` returns the SIP credentials once, and they are entered into the client by
hand. Two clients are verified against Zamfono and recommended.

## Groundwire (Acrobits)

- Mobile (iOS/Android). A one-time purchase, no subscription — the recommended no-subscription
  mobile option.
- Vendor-run push notifications, so it wakes for calls without keeping a persistent connection.
- Supports BLF.
- Set the account transport to match the device's `devices.transport`: `tls` from anywhere, or
  `plain` only from an address on the device's allowlist (see `remote-workers`).

## MicroSIP

- Windows desktop only.
- Needs no push, since a desktop client stays connected while running.
- Lightweight, open source, a common choice for a reception desk or an always-on office PC.

Both register with the SIP credentials from `POST /users/{id}/devices` (or a rotated set from
`POST /devices/{id}/rotate`) exactly as any standard SIP account would — Zamfono provisions
nothing client-specific for `manual` devices.
