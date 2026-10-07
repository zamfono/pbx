# Mental model

Zamfono configures one phone system for one company (the tenant). Everything below lives in
that single tenant; there is no cross-tenant sharing.

## Entities

- **User** — a person with an e-mail, an extension or both, a role (`owner`, `admin` or `user`)
  and zero or more **devices**. Each device is one SIP registration (a softphone or a desk phone).
  A user's extension is shared by all their devices; only the device slug differs. Without an
  extension a user has no devices and is in no ring group; without an e-mail, a phone-only
  `user`, they cannot log in.
- **Trunk** — a connection to a PSTN or SIP provider. Trunks carry the tenant's inbound and
  outbound calls and are tried in a configured order; only those flagged `emergency` carry
  emergency calls. A trunk with `transport` `tls` checks its provider's certificate
  (`tlsVerify`, on for a new trunk; off only for a provider with a self-signed certificate) and
  can encrypt its media too (`srtp`, for a provider that requires SRTP; `tls` trunks only). An
  `ip` trunk's `status` comes from an OPTIONS probe every 60 seconds (`qualify`, on for a new
  trunk); a trunk with it off, for an endpoint that never answers one, reads `unmonitored` and is
  always tried. A trunk's `diversion` says what a call forwarded out over it tells the far end
  about who forwarded it: `off` (the default) nothing, `last` the last forward, `all` every
  forward, each by the forwarder's own number or the company's main number, never an extension.
  Some carriers show the original caller's number on a forwarded call only when it carries one,
  and a trunk's `forwardedCallerId` puts that number in `From` itself, for a carrier contract
  with "CLIP no screening". See `caller-id` for what a trunk presents and where.
- **DID** — a phone number the tenant owns, routed on arrival to a forward target. A **number
  block** (`didBlocks`) covers the numbers that begin with a base, either a fixed count of digits
  after it or any number of them, and gives the ones no DID holds a fallback target, for a
  provider that hands over a whole range instead of individual DIDs. The company's **main
  number** is one of the DIDs, `settings.mainDidId`. See `numbers`.
- **Ring group** — an ordered or unordered set of users (and nested user groups) rung together
  under one strategy (`simultaneous`, `sequential` or `random`).
- **Menu** — a greeting plus a map of DTMF digits to forward targets, usable anywhere a target is
  usable, including as one option of another menu.
- **User group** — a named, nestable set of users, used as ring-group membership and as an
  outbound-route caller list. See `user-groups`.
- **Contact** — a phone-book entry with one or more numbers, shared tenant-wide, that names
  inbound callers. See `directory`.
- **Parking slot** — an extension of its own kind that holds a parked call until someone dials
  it. See `parking`.
- **Webhook** — an HTTP endpoint the stack POSTs its realtime events to, signed with a per-hook
  secret. See `webhooks`.
- **Settings** — the one tenant-wide row: time zone, language, feature codes, emergency numbers,
  the mail relay, and every other tenant default.

## Forward-target vocabulary

Every place that routes a call somewhere else — a DID, a menu option, a forward rule, an
out-of-office rule, a group fallback, an opening-hours closed target — points at one of the same
eight target kinds:

| Kind               | Meaning                                                            |
| ------------------ | ------------------------------------------------------------------ |
| `user`             | rings that user, entering the routing pipeline                     |
| `ringGroup`        | rings that group, entering the routing pipeline                    |
| `external`         | dials an external number through the outbound routes               |
| `sip`              | dials a SIP address over one trunk, no outbound route (admin-only) |
| `mailboxUser`      | deposits the caller directly in a user's mailbox, no ringing       |
| `mailboxRingGroup` | deposits the caller directly in a ring group's mailbox, no ringing |
| `announcement`     | plays an audio asset and ends the call                             |
| `menu`             | plays a menu's greeting and collects DTMF                          |

A `user` or `ringGroup` target re-enters the routing pipeline and counts a hop toward the
three-hop forwarding limit (`routing-order`); a `menu` target re-enters without counting a hop.
`mailboxUser`, `mailboxRingGroup` and `announcement` end the pipeline; `external` dials out
through the outbound routes, and `sip`, `{ "kind": "sip", "trunkId": "…", "user": "…" }`, dials
`sip:<user>@<host>` at the trunk's own hosts, such as an AI agent's endpoint
(`forward-to-ai-agent`). A `sip` leg tells the far end who called through the target's
headers; either leg tells it who forwarded only as far as the trunk's `diversion` allows.

## Where to look next

- `routing-order` — the order every call is decided in, inbound and outbound.
- `numbers` — DIDs, number blocks, the main number and the fallbacks, with a worked example.
- `glossary` — short definitions of the terms used across the guide and the REST/MCP surface.
- `guardrails` — what the API refuses, confirms or lets you undo.
- `user-groups` — nestable sets of users for ring groups and outbound routes.
- `parking` — parking slots, park and retrieve, the ring-back to the parker.
- `click-to-dial` — placing a call on a user's phones from outside, a slot or one call's CLIR.
- `directory` — the phone book, caller names and the type-ahead search.
- `call-data` — voicemails, the presence history and the call statistics.
- `mail-templates` — the mails the stack sends, their languages and placeholders.
- `webhooks` — the realtime events, their delivery and how to verify the signature.
