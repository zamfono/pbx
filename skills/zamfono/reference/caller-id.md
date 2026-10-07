# Caller ID on trunks

What a call leaving over a trunk tells the provider about who is calling, and who forwarded it.
Every setting here is a field of the trunk, set with `trunks.create` (`POST /api/v1/trunks`) or
`trunks.update` (`PATCH /api/v1/trunks/{id}`).

## The presented number

An outbound call presents one of the tenant's own DIDs, the first of:

1. the matching outbound route's `callerIdDidId` (set with
   `outboundRoutes.replace` (`PUT /api/v1/outboundRoutes`));
2. the calling user's own `callerIdDidId`, their primary number (set with
   `users.update` (`PATCH /api/v1/users/{id}`));
3. the company's main number, `settings.mainDidId` (set with
   `settings.update` (`PATCH /api/v1/settings`)).

A forward is the forwarding user's call, and a transfer the transferring user's; a forward that a
DID, menu, ring group or tenant rule makes has no user and presents the main number unless a route
sets one. `callerIdFormat` sends the number as `e164` (the default, `+4930…`) or `national` (as
dialled within `settings.country`, `030…`).

## Where it goes: `callerIdHeader`

| `callerIdHeader` | `From`                           | `P-Asserted-Identity` |
| ---------------- | -------------------------------- | --------------------- |
| `from` (default) | the presented number             | none                  |
| `pai`            | the trunk's account (`username`) | the presented number  |
| `both`           | the presented number             | the presented number  |

Use what the provider documents; `pai` needs a `username`.

## Withholding the number (CLIR)

A withheld call keeps the real number in `P-Asserted-Identity` with `Privacy: id`, and the
provider removes it before the callee. That needs a trunk that sends `P-Asserted-Identity`: the
API refuses `clir: true` on a `from` trunk, and a withheld call skips a route over one. The first
level that is set decides: `#31#` (withhold) or `*31#` (show) dialled before the number, the
user's `clir`, the trunk's `clir`, the tenant's `settings.clir`. Emergency calls are never
withheld.

## Who forwarded it: `diversion`

A call forwarded out to an external number or a `sip` target, including a DID or a number block's or
the tenant's fallback whose target is one, or blind-transferred, can carry a `Diversion` header
naming whoever forwarded or transferred it, by their own number or the main number, never an
extension: `off` (the default) sends none, `last` the newest forward, `all` every forward, newest
first. Carriers that show the original caller on a forwarded call recognise the forward by it. A DID
or a fallback names the called number and the DID's or block's label, reason `unconditional`; a
blind transfer names the transferring user, reason `deflection`, before any forward its target
makes.

## Presenting the original caller: `forwardedCallerId`

By default a forwarded call shows the company's number to the person it is forwarded to. With
`forwardedCallerId` the trunk can show the original caller instead, for a carrier contract that
includes it, usually sold as "CLIP no screening":

| `forwardedCallerId` | `From`               | identity header                              | `Diversion`         |
| ------------------- | -------------------- | -------------------------------------------- | ------------------- |
| `own` (default)     | the company's number | none                                         | as `diversion` says |
| `original`          | the original caller  | `P-Asserted-Identity`: the company's number  | as `diversion` says |
| `originalPreferred` | the original caller  | `P-Preferred-Identity`: the company's number | as `diversion` says |

The company's number is the one the call presents under `own`, as above, in the same format; the
host is the stack's own name. Choose `originalPreferred` for a provider that asks for
`P-Preferred-Identity` instead of `P-Asserted-Identity`.

It applies to a call forwarded out to an `external` or `sip` target (a DID's or fallback's own
target and a ring-group member's own forward included) and to a blind transfer, over the API with
`calls.transfer` (`POST /api/v1/calls/{id}/transfer`) or from the phone, to an external number or to
a colleague whose forward sends it out. An attended transfer, a find-me leg, a user's own call,
click-to-dial and `*5` present the company's number as always. So does any call whose original
caller is no outside caller with a shown number, a withheld caller or a colleague, and any leg that
sends no `Diversion`.

The API takes `original` and `originalPreferred` only on a trunk with `callerIdHeader` `from` and
`diversion` `last` or `all`, and refuses a change that would leave such a trunk without either.

In Germany, § 120 (2) TKG allows this only on a call that is passed on (a "Rufumleitung"), and
only with the caller's number as transmitted and displayed: the number the network vouches for
stays the company's own. Book the feature with the carrier first; without it the carrier replaces
or rejects the foreign number.
