# Call control

What a user does with a call on their phone, an integration or the MCP assistant does through
the API: transfer it, consult someone first, add a third party, hold it, decline it. Each
operation runs the same code in the PBX as the phone's own feature, so the call history, the
routing trace (`diagnose-bad-call`), the recording rules, CLIR and the channel cap come out the
same; the trace names who acted, as `actorUserId`.

## Who may control a call

A `user` controls a call in progress (`calls.list` with `live: true`) that they placed, while
their own phone is still in it, or in which one of their phones is connected right now. A caller
who parked the call, or handed it on with an attended transfer, no longer controls it, though
the history still names them as its caller. `admin` and `owner` control every call. Anything
else is refused with 403 (`guardrails`). Declining is different: it acts only on the requesting
user's own ringing phones.

Each call in progress that `calls.list` (`GET /calls?live=true`) returns carries `callId`,
`direction`, `from`, `to`, `state` (`ringing` or `up`), `startedAt`, `ringGroupId`, `userIds`:
the users the call concerns now, its caller, callee and answerer and everyone whose phone rings
or is connected in it, so a CRM can tell whose call it is, and `legs`, the parties in it now.
Each leg has an `id`, a `role` (`caller`, `callee`, or `added` for a party added to the call), a
`state` (`ringing`, `up`, `held`) and whichever applies of `userId`, `deviceId`, `trunkId` and
`target`, the number or SIP target a trunk leg dials. A call a number forwards to a SIP target
has legs but no user.

## Naming the leg

`calls.transfer`, `calls.park`, `calls.consult` and `calls.hold` take `legId`, one of the call's
`legs`: the party that moves, is parked or is held. The other side then acts as you would: it is
released by a transfer, is the parker the ring-back rings, holds the call or dials the
consultation. Without `legId` they take your own other party, so an admin or owner who is not in
the call must name a leg (422 otherwise); that is how a call with no user in it, such as one a
number forwards to a SIP target, is transferred. `calls.hangup` with `legId` hangs up that leg
alone, as its phone hanging up would. A `user` names legs only of calls they control. A leg the
call does not hold is 404 `legNotFound`, one still ringing 409 `legNotUp`, an added party's 409
`notBridged`; with `toCallId`, a leg other than the held party is 409 `notHeld`.

A refused action names its reason in the problem's `detail`: 404 `notFound` for a call no longer
in progress, 409 for a call in the wrong state (`notBridged`, not answered yet; `held`;
`notHeld`; `consulting`; `notConsultation`; `notAnswered`; `notRinging`), 422 `invalidTarget` for
a target nobody could answer on, such as a parking slot or a feature code.

## Blind transfer, pickup, hangup

- `calls.transfer` (`POST /calls/{id}/transfer`) with `{ "target": "102" }` hands the other party
  on to an extension or number as a new call, routed as yours.
- `calls.pickup` (`POST /calls/{id}/pickup`) takes a call ringing for someone else on your phones,
  as `*8` does.
- `calls.hangup` (`POST /calls/{id}/hangup`) ends a call for everyone in it.
- `calls.originate` (`POST /calls`) is click-to-dial: your phones ring first, then the target.

## Hold and resume

`calls.hold` (`POST /calls/{id}/hold`) puts the other party on hold: they hear the hold music
(`settings.holdMohAudioId`, else the built-in default), and you and they no longer hear each
other. `calls.resume` (`POST /calls/{id}/resume`) brings them back.

The hold happens in the PBX, not on the phone, so the phone does not show it, and its own hold
button is a separate matter: pressing it, or resuming on the phone, does not end a hold made
through the API. Hanging up, transferring and parking work as usual while the call is held; a
transfer or park first brings the held party back. Either side hanging up ends the call as it
would otherwise.

## Attended transfer

1. `calls.consult` (`POST /calls/{id}/consult`) with `{ "target": "102" }` puts the other party
   on hold and dials the target from you, an extension or a number, as your phone would dial it.
   The answer carries `callId`, the consultation call's id. You hear nothing while it rings.
2. Once the target answers, you talk to them; the other party still hears the hold music.
3. `calls.transfer` (`POST /calls/{id}/transfer`) with `{ "toCallId": "<callId>" }` joins the
   held party to the target and takes you out of both calls. As with a phone's own attended
   transfer, the original call's history entry closes, and the consultation's entry carries the
   conversation on with `parentCallId` set to the original call.

Instead of transferring:

- the target hanging up, or `calls.hangup` on the consultation, leaves you in the call with the
  other party still on hold; `calls.resume` brings them back;
- `calls.resume` while the target is still on the line joins all three, as a three-way call;
- your own phone hanging up ends both calls.

The consultation only rings its target: no forward or mailbox of theirs applies, since no phone
line of yours would hear it. A second `calls.consult` while one is in progress is refused with
409 `consulting`.

## Three-way calls

`calls.addParty` (`POST /calls/{id}/parties`) with `{ "target": "103" }` does what `*5103` does
from a phone: it dials the target from you and, once they answer, adds them to the call, so all
three talk. The answer carries `callId`, the added party's own call, whose history entry has
`parentCallId` set to the call they joined ("Ben joined at 14:02"), and whose recording follows
their own flags. The added party hanging up leaves the other two talking; you hanging up ends
the call for everyone. Like the consultation, it only rings its target.

## Declining a call

`calls.decline` (`POST /calls/{id}/decline`) declines a call ringing for you, as declining it on
your phone would: your phones stop ringing for it. A call to you directly then goes on to your
`noAnswer` rule (your mailbox by default, `routing-order`). A ring group drops you and rings its
other members: with the group's `allowReject` on, the default, a sequential group moves on at
once and the group's fallback comes early once every member declined; with it off, the group
rings on to its timeout. It acts only on your own ring, never someone else's, and answers 409
`notRinging` when none of your phones rings for the call.
