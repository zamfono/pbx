# Numbers

How an inbound call finds its way from the number the caller dialled to a forward target: DIDs,
number blocks, the main number and the fallbacks.

## DIDs

A **DID** is one phone number the tenant owns, with the forward target its calls go to:
`dids.create` (`POST /dids`) takes `number`, an optional `label` and `target`.

```json
{
  "number": "+4989123456",
  "label": "Sales",
  "target": { "kind": "ringGroup", "ringGroupId": "…" }
}
```

`number` is stored as the trunk boundary produces it: the international form, `+` and digits.
A national number is accepted and normalized with the tenant's `settings.country`, so
`089123456` for a German tenant is stored as `+4989123456`; `0049…` becomes `+49…`. A DID's
`number` and `label` are fixed once created; `dids.update` (`PATCH /dids/{id}`) changes its
target. The first numeric DID whose target is a user who presents no number yet becomes that
user's caller ID (`callerIdDidId`).

Numbers are not bound to a trunk: a call is matched by its called number alone, whichever trunk
delivered it. The trunk's `inboundNumberFormat` (`e164` or `national`) says how the provider
writes the numbers it sends; either way it must send the complete number, not just the digits
behind a block's base.

### Numbers a provider sends verbatim

A called party that is not digits with an optional leading `+` passes the trunk boundary
unchanged and is matched as it is. Some registration providers address the call to the account
name, such as `acct-4711`; a DID with that string as its `number` catches it. Such a DID routes
calls like any other but can never be presented as a caller ID, the main number included.

## Number blocks

A **number block** (`didBlocks`) describes a range of numbers by its `base`, the digits every
number in it begins with. It comes in two kinds:

| Kind       | `digits`                 | Covers                                                    | Example: base `+498912347`       |
| ---------- | ------------------------ | --------------------------------------------------------- | -------------------------------- |
| fixed      | a positive count, e.g. 2 | the base followed by exactly that many digits             | `+49891234700` to `+49891234799` |
| open-ended | `null`, or left out      | the base followed by any number of digits, including none | `+498912347`, `+4989123471`, …   |

A block groups the DIDs whose numbers fall within it and supplies a fallback for the numbers in
it that no DID holds; it routes nothing by itself. A DID belongs to a block by its number alone
(nothing links them), so a block is created before or after its DIDs, in any order. The digits
behind the base are never read as an extension: a caller who dials `+4989123471` gets the
block's fallback, not the user with extension `1`, unless a DID `+4989123471` exists.

`didBlocks.create` (`POST /didBlocks`) takes `base` (E.164 or national, normalized like a DID's
number), `digits` (a positive count, or `null`/omitted for an open-ended block), an optional
`label` and an optional `fallbackTarget`, any forward target; a base another live block already
has is refused with 409. `didBlocks.update`
(`PATCH /didBlocks/{id}`) changes `label`, `digits` and `fallbackTarget`; the base is fixed, so a
different range is a new block. `didBlocks.delete` (`DELETE /didBlocks/{id}`) is refused with 409
while a live DID falls within the block, and lists those DIDs.

```json
{
  "base": "+498912347",
  "digits": null,
  "label": "Head office",
  "fallbackTarget": { "kind": "announcement", "audioId": "…" }
}
```

## Most precise match

An inbound number resolves, in this order:

1. a DID with exactly that `number`;
2. else the block with the longest base that covers it: that block's `fallbackTarget`;
3. else, when that block has no fallback or no block covers the number, the tenant-wide
   `settings.fallbackTarget`;
4. else the call is released with 404.

An exact DID always wins over any block, and a narrower block inside a wider one wins for its
own numbers. A block without a fallback falls straight to the tenant-wide one, not to a wider
block around it. Every fallback decision appears in the call's routing trace at level `events`
(`diagnose-bad-call`).

## Fallbacks

Both fallbacks are ordinary forward targets (`mental-model`). An `announcement` ("this number
does not exist") suits mis-dials; a reception ring group or a menu suits a block whose callers
should still reach someone. The tenant-wide fallback is set with `settings.update`
(`PATCH /settings`) as `fallbackTarget`, `null` clears it; while it is `null`, a call no DID or
block fallback catches is released with 404.

## The main number

The **main number** is a DID like any other, referenced by `settings.mainDidId`. It is presented
as the caller ID of a call that neither its outbound route nor its caller sets a number for, and
of the calls the system dials without a user. The stack seeds it from `MAIN_DID` at first boot,
with the owner as its target; retarget it with `dids.update` like any DID. `settings.update`
(`PATCH /settings`) points `mainDidId` at another DID, which must be live and numeric, and
`dids.delete` refuses the DID that is currently the main number.

## Worked example: a German PBX line

A German PBX line (Anlagenanschluss) comes as a base number, the Kopfnummer `089 12347`, followed
by extensions of varying length: `0` for the switchboard, `10` to `39` for staff, `200` for the
sales team. The provider delivers every number in full, `+498912347` followed by whatever
extension the caller dialled.

1. One open-ended block on the base, so every number of the line is the tenant's and a mis-dialled
   extension lands somewhere sensible: `didBlocks.create` (`POST /didBlocks`) with
   `{ "base": "+498912347", "digits": null, "fallbackTarget": … }`, the fallback an announcement
   or the reception ring group. A caller who dials the bare base, with no extension, gets the
   fallback too, unless a DID `+498912347` exists.
2. The main number, the switchboard extension `0`, as a DID to reception, set as the main number:
   `dids.create` (`POST /dids`) with `{ "number": "+4989123470", "target": … }`, then
   `settings.update` (`PATCH /settings`) with `{ "mainDidId": "<its id>" }`. A stack seeded with
   `MAIN_DID=+4989123470` already has this DID as the main number; retarget it instead.
3. One DID per direct-dial extension: `+49891234710` to Anna's `user` target, `+49891234711` to
   Ben's, `+498912347200` to the sales ring group. Each user's first DID becomes their caller ID.

A call for `+49891234712`, which no DID holds, goes to the block's fallback; a call for
`+4930555`, outside the block, to the tenant-wide fallback or a 404. Extensions added to the line
later need only their DIDs; the block stays as it is.
