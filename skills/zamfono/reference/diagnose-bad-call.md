---
title: Diagnose a bad call
arguments:
  - name: callerNumber
    description: The caller's number, to narrow the search when the call id is not known
    required: false
  - name: userId
    description: The user or ring group the call went to, to narrow the search
    required: false
  - name: from
    description: Start of the time range to search, ISO 8601; without an offset, the tenant's local time
    required: false
  - name: to
    description: End of the time range to search, ISO 8601; without an offset, the tenant's local time
    required: false
---

# Diagnose a bad call

1. Find the call: `calls.list` (`GET /calls?direction=&from=&to=&userId=&ringGroupId=&status=`).
   `status` distinguishes answered from missed; a live call in progress is `calls.list`
   (`GET /calls?live=true`).
2. Read its routing trace. At the tenant's default diagnostics level (`events`) each call's
   `calls.log` already carries the DID match, the out-of-office and opening-hours evaluation, the
   members rung, who answered or declined, and the fallback taken — narrow the same `calls.list`
   (`GET /calls`) listing with `from`/`to` and `userId`/`ringGroupId` until the one call stands out,
   then read it with `calls.get` (`GET /calls/{id}`). The lines that answer the usual questions:
   - `ooo`, `hours`: whether an out-of-office rule or opening hours applied; `hours` with
     `schedule: <scope>` names whose opening hours decided (the target's own, or the tenant's it
     falls back to) and `open`; `schedule: null` means no opening hours cover the target.
   - `user`: the user step's `decision` (ring, forward, mailbox, release), its `reason` (`dnd`,
     `offline`, `unconditional`) and `registeredDevices`; `offline` with 0 devices means no phone
     of the user was registered.
   - `voicemail`: the mailbox and the `reason` the call reached it (`dnd`, `offline`, `busy`,
     `noAnswer`, `unanswered`, `unavailable`, `target`, `hopLimit`, …); `voicemailFailed` why no
     message was kept (`callerHungUp`, `hangup` during the greeting, `destroyed` when the channel
     went during the recording without the caller hanging up, `failed`, and `missingDeps`, a
     `core` running without its database or its link to `api`, when the call is released).
   - `rungDevice`, `ringGroupMember`, `declined` (with the Q.850 `cause`), `answered` (the
     `channelId`, the `leg` kind and the `userId` and `deviceId`, or the `trunkId` of a trunk leg).
     A `rungDevice` or `ringGroupMember` with `cause: placementFailed` and a `deviceId` in place of
     a `channelId` is a phone Asterisk would not place at all: it never rang.
   - `attempt`: one per outbound INVITE, with the trunk, the endpoint, the `callerId` presented
     (`number`, `format`, `header`, `withheld`) and the `cause`. An `attempt` with
     `cause: placementFailed` has no `callerId`: Asterisk would not place the leg, no INVITE left,
     and the next host or route was tried.
   - `pickupRing`: a pickup through the API rings the picker's own phones first; those lines, in
     the picked-up call's trace, carry the original event in `step` (`rungDevice`, `declined`, …),
     so a pickup that never connected shows which of the picker's phones rang or failed.
   - `codecs`: the codec each side of the bridge negotiated; two different ones mean Asterisk
     transcodes.
   - `ended`: who ended the call — `caller`, `callee`, or `system` (a release, a hangup through
     the API, a transfer) — with the Q.850 `cause`, `causeTxt` and the `sipCode`.
3. If the trace does not explain the symptom (a call that never reached a device, dropped audio,
   choppy or one-way audio), raise the diagnostics level for the specific user, trunk or ring
   group under suspicion to `qos` (adds a per-leg RTCP summary: `jitterMs`, `lossPct` and `rttMs`
   per leg, the worse of both directions, `rttMs` null until the far end sent an RTCP report,
   `jitterMs` and `lossPct` null for a leg that received nothing and whose far end never
   reported, as one-way audio can leave it, and the packets the leg received from its far end and
   sent to it, `rxPackets` and `txPackets`) or
   `sip` (adds the SIP messages themselves, HEP-mirrored from Asterisk) rather than raising it
   tenant-wide. An override without an explicit expiry lapses automatically after 7 days.
   - `rxPackets: 0` on a leg of an answered call means no audio ever arrived from that side: its
     RTP was dropped on the way, usually by NAT or a firewall on the device's side, or it was sent
     to a wrong address. At level `sip`, check the `c=` line of the SDP that side sent: a private
     address (`10.…`, `172.16–31.…`, `192.168.…`) behind NAT is the classic cause. A leg whose
     figures are all null but whose `rxPackets` is above 0 received audio; only its far end sends
     no RTCP. `rxPackets` null means the count is unknown (a row from RTCP reports alone, or one
     written before the counts existed), not 0.
   - The opposite case, Asterisk's audio not reaching the device, is not visible in these counts:
     `txPackets` counts what Asterisk sent, not what arrived. The far end hears nothing while its
     own leg reads a healthy `txPackets`; ask the person on that side, or read the other leg's
     `rxPackets`, which shows whether audio reached Asterisk to be relayed at all.
4. For a trunk suspected of failing calls outbound, check `trunks.get` (`GET /trunks/{id}`) for its
   registration and reachability status before reading its call log; an `unreachable` trunk is
   skipped in trunk-order failover and in emergency-call dialling alike, and a trunk without
   `emergency` set never carries an emergency call at all (see `emergency-calls`).
5. Reproduce the call at the raised level, then re-read its trace; drop the override back to the
   tenant default once done, since a diagnostics override left on is a bigger `calls.log` for
   every call the entity takes part in.

`audit.list` (`GET /audit`) shows who raised or lowered the level and when, since a diagnostics
change is a normal audited mutation.
