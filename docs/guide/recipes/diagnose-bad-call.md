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
   (`GET /calls`) listing with `from`/`to` and `userId`/`ringGroupId` until the one call stands out.
3. If the trace does not explain the symptom (a call that never reached a device, dropped audio,
   a codec mismatch), raise the diagnostics level for the specific user, trunk or ring group
   under suspicion to `qos` (adds a per-leg RTCP summary) or `sip` (adds the SIP messages
   themselves, HEP-mirrored from Asterisk) rather than raising it tenant-wide. An override
   without an explicit expiry lapses automatically after 7 days.
4. For a trunk suspected of failing calls outbound, check `trunks.get` (`GET /trunks/{id}`) for its
   registration and reachability status before reading its call log; an `unreachable` trunk is
   skipped in trunk-order failover and in emergency-call dialling alike, and a trunk without
   `emergency` set never carries an emergency call at all (see `emergency-calls`).
5. Reproduce the call at the raised level, then re-read its trace; drop the override back to the
   tenant default once done, since a diagnostics override left on is a bigger `calls.log` for
   every call the entity takes part in.

`audit.list` (`GET /audit`) shows who raised or lowered the level and when, since a diagnostics
change is a normal audited mutation.
