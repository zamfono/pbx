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
    description: Start of the time range to search, ISO 8601
    required: false
  - name: to
    description: End of the time range to search, ISO 8601
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
     `schedule: null` means no opening hours cover the target.
   - `user`: the user step's `decision` (ring, forward, mailbox, release), its `reason` (`dnd`,
     `offline`, `unconditional`) and `registeredDevices`; `offline` with 0 devices means no phone
     of the user was registered.
   - `voicemail`: the mailbox and the `reason` the call reached it (`dnd`, `offline`, `busy`,
     `noAnswer`, `unanswered`, `unavailable`, `target`, `hopLimit`, …); `voicemailFailed` why no
     message was kept (`callerHungUp`, `hangup` during the greeting, `failed`).
   - `rungDevice`, `ringGroupMember`, `declined` (with the Q.850 `cause`), `answered` (the
     `channelId`, the `leg` kind and the `userId` and `deviceId`, or the `trunkId` of a trunk leg).
   - `attempt`: one per outbound INVITE, with the trunk, the endpoint, the `callerId` presented
     (`number`, `format`, `header`, `withheld`) and the `cause`.
   - `codecs`: the codec each side of the bridge negotiated; two different ones mean Asterisk
     transcodes.
   - `ended`: who ended the call — `caller`, `callee`, or `system` (a release, a hangup through
     the API, a transfer) — with the Q.850 `cause`, `causeTxt` and the `sipCode`.
3. If the trace does not explain the symptom (a call that never reached a device, dropped audio,
   choppy or one-way audio), raise the diagnostics level for the specific user, trunk or ring
   group under suspicion to `qos` (adds a per-leg RTCP summary: `jitterMs`, `lossPct` and `rttMs`
   per leg, the worse of both directions, `rttMs` null until the far end sent an RTCP report) or
   `sip` (adds the SIP messages themselves, HEP-mirrored from Asterisk) rather than raising it
   tenant-wide. An override without an explicit expiry lapses automatically after 7 days.
4. For a trunk suspected of failing calls outbound, check `trunks.get` (`GET /trunks/{id}`) for its
   registration and reachability status before reading its call log; an `unreachable` trunk is
   skipped in trunk-order failover and in emergency-call dialling alike, and a trunk without
   `emergency` set never carries an emergency call at all (see `emergency-calls`).
5. Reproduce the call at the raised level, then re-read its trace; drop the override back to the
   tenant default once done, since a diagnostics override left on is a bigger `calls.log` for
   every call the entity takes part in.

`audit.list` (`GET /audit`) shows who raised or lowered the level and when, since a diagnostics
change is a normal audited mutation.
