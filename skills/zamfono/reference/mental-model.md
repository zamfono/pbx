# Mental model

Zamfono configures one phone system for one company (the tenant). Everything below lives in
that single tenant; there is no cross-tenant sharing.

## Entities

- **User** — a person with an extension, a role (`owner`, `admin` or `user`) and zero or more
  **devices**. Each device is one SIP registration (a softphone or a desk phone). A user's
  extension is shared by all their devices; only the device slug differs.
- **Trunk** — a connection to a PSTN or SIP provider. Trunks carry the tenant's inbound and
  outbound calls and are tried in a configured order.
- **DID** — a phone number the tenant owns, routed on arrival to a forward target. A **DID
  block** groups a contiguous range of numbers under one fallback target, for a provider that
  hands over a whole range instead of individual DIDs.
- **Ring group** — an ordered or unordered set of users (and nested user groups) rung together
  under one strategy (`simultaneous`, `sequential` or `random`).
- **Menu** — a greeting plus a map of DTMF digits to forward targets, usable anywhere a target is
  usable, including as one option of another menu.
- **User group** — a named, nestable set of users, used as ring-group membership and as an
  outbound-route caller list.
- **Contact** — a phone-book entry with one or more numbers, shared tenant-wide.
- **Settings** — the one tenant-wide row: time zone, language, feature codes, emergency numbers,
  the mail relay, and every other tenant default.

## Forward-target vocabulary

Every place that routes a call somewhere else — a DID, a menu option, a forward rule, an
out-of-office rule, a group fallback, an opening-hours closed target — points at one of the same
seven target kinds:

| Kind | Meaning |
|---|---|
| `user` | rings that user, entering the routing pipeline |
| `ringGroup` | rings that group, entering the routing pipeline |
| `external` | dials an external number through the outbound routes |
| `mailboxUser` | deposits the caller directly in a user's mailbox, no ringing |
| `mailboxRingGroup` | deposits the caller directly in a ring group's mailbox, no ringing |
| `announcement` | plays an audio asset and ends the call |
| `menu` | plays a menu's greeting and collects DTMF |

A `user` or `ringGroup` target re-enters the routing pipeline and counts a hop toward the
three-hop forwarding limit (`routing-order`); a `menu` target re-enters without counting a hop.
`mailboxUser`, `mailboxRingGroup` and `announcement` end the pipeline; `external` dials out
through the outbound routes.

## Where to look next

- `routing-order` — the order every call is decided in, inbound and outbound.
- `glossary` — short definitions of the terms used across the guide and the REST/MCP surface.
- `guardrails` — what the API refuses, confirms or lets you undo.
