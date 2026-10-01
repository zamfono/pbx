# Call parking

Parking puts a caller on hold in a shared slot so anyone can take the call from any phone: the
receptionist parks "a call for Ben on 71", Ben dials `71` from his desk.

## Slots are extensions

A parking slot is an extension of its own kind, next to the users' and ring groups' extensions
and of the same length (`settings.extLength`). Nine are seeded at first boot: `7` followed by
zeros and the digits 1 to 9, so `71` to `79` for two-digit extensions, `701` to `709` for three,
`7001` to `7009` for four. Slots are tenant-wide; nobody owns one.

- `parking.get` (`GET /parking/slots`) returns `{ "slots": ["71", …] }`.
- `parking.set` (`PUT /parking/slots`) replaces the set as a whole with
  `{ "slots": [...] }`. A slot of the wrong length or listed twice is refused with 422, and one
  that is already a user's or ring group's extension with 409 naming its owner. Removing a slot
  also removes the BLF keys devices had for it; the audit entry records them and `audit.undo`
  restores both (`guardrails`).

Both are `admin`. A change is in force on the PBX at once and is pushed to the Ringotel apps'
profile, which lists the slots (`ringotel-setup`). A slot cannot be given to a user or ring
group while it is a slot, and a menu's `allowExtensionDialing` never reaches one.

## Park and retrieve

1. **Park.** In a call, the parker dials the park code, `*70` by default
   (`settings.featureCodes.park`), as a second call from their phone, typically after putting the
   call on hold. The other party moves to a holding bridge and hears the hold music
   (`settings.holdMohAudioId`, else the built-in default), the lowest free slot is taken, and its
   number is read out to the parker, who hangs up. The park fails when the parker is in no call
   or every slot is taken; the call stays where it was.
2. **Retrieve.** Dialling the slot from any device takes the call: the retriever is connected to
   the parked party and the slot is free again. Dialling an empty slot plays a short error tone.
3. **Ring-back.** A call still parked after `settings.parkingTimeoutS` seconds (default 300) rings
   the parker back as an internal call to the parker's own extension, so the parker's own rules
   apply: DND, forwarding, the mailbox. When that call ends unanswered, the parked party goes to
   the tenant-wide fallback target (`settings.fallbackTarget`, `numbers`), or is released when
   there is none.

A parked party who hangs up frees the slot. A restart of the `core` container hangs up parked
calls whose parker it no longer knows. The parker appears in the call's routing trace
(`diagnose-bad-call`).

## Over the API

The same park and retrieve, for an integration or the MCP assistant:

- `calls.park` (`POST /calls/{id}/park`) parks the other party of a live call exactly as `*70`
  does: the hold music, the lowest free slot, the parker's leg hung up, the ring-back on timeout.
  No phone hears the slot read out, so the result carries it: `{ "id": "…", "slot": "71" }`. A
  `user` parks a call they are connected in; an admin names the user in the call who parks it with
  `userId`, since the parker is who the ring-back rings. Refused with 409 `noFreeSlot` when every
  slot is taken, `notInCall` when that user is not in the call, `notBridged` for a call not
  yet answered or for the call of a party added to another, which shares that call's
  conversation.
- `parking.list` (`GET /parking/calls`) lists the calls parked right now to every user, as every
  phone's BLF shows every slot: `slot`, `callId`, `caller` (the parked party's number, `null` when
  they withheld it), `parkedAt` and `parkedByUserId`.
- Retrieve by dialling the slot: `calls.originate` (`POST /calls`) with the slot as `target` rings
  the user's own phones, and the one that answers takes the call, as dialling the slot from it
  would (`click-to-dial`). Any user may.

A parked call has nobody connected in it, the parker having left, so `calls.hangup` ends it for an
admin only, as it ends any call. When the parker answers the ring-back, they are connected in the
parked call itself again and may hang it up or transfer it like any call they are in.

## Seeing who is parked

Each slot has a BLF hint that reads in use while a call is parked there, so a lamp per slot shows
where the waiting callers are. On a `manual` device the lamps are configured on the phone itself;
on a Ringotel device, add the slots to the device's BLF list with `devices.setBlf`
(`PUT /devices/{id}/blf`).
