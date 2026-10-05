# Call data

What the stack records as calls happen, and how to read it: voicemails, the presence history and
the call statistics. The call history itself is `calls.list` (`GET /api/v1/calls`) and `calls.get`
(`GET /api/v1/calls/{id}`); its routing trace is in `diagnose-bad-call`.

## Voicemails

**Where they come from.** Every user has a mailbox (`mailboxEnabled`), and a ring group can have
one, off by default. A caller is left in a mailbox when a forward rule or a ring group's fallback
ends there, implicitly when no rule is set and the mailbox is enabled (`routing-order`), or
explicitly through a `mailboxUser` or `mailboxRingGroup` target, which deposits whether or not the
mailbox is enabled. `*97<ext>` puts a caller straight through to a mailbox, and so does
`calls.transfer` (`POST /api/v1/calls/{id}/transfer`) with `{ "target": "102", "voicemail": true }`:
the other party goes to the mailbox of the user or ring group owning that extension without ringing
anyone, and an extension nobody owns is refused with 422 `noMailbox`. The caller hears the mailbox's
greeting, or the default prompt in the tenant language, and records up to `settings.voicemailMaxS`
seconds (default 180), ended by `#` or 5 s of silence. A mailbox holds at most `mailboxMaxMessages`
messages (`users.update`, `ringGroups.update`; 100 by default, `null` for no limit): a caller to a
full one hears that it is full, leaves nothing, and is a missed call.

**The personal greeting.** `users.setVoicemailGreeting` (`PUT /api/v1/users/{id}/voicemailGreeting`)
takes a WAV or MP3 file as multipart form data, field `upload`, transcoded like any audio upload,
and makes it the user's mailbox greeting, replacing the one before, exactly as recording one on
`*96` does. As an MCP tool it takes no file and returns `{ url, expiresAt }`, an upload link for
five minutes: post the file to it as the field `upload`, or open it in a browser to pick the file;
`audio.create` does the same with its `kind` and `label`. `users.clearVoicemailGreeting`
(`DELETE /api/v1/users/{id}/voicemailGreeting`, confirmed) goes back to the default prompt. Both are
a user's own on their own id, an admin's for anyone, and, like the phone's recording, not in the
audit log. A ring group's greeting is its `mailboxAudioId` (`ringGroups.update`).

**What follows a message.** The mailbox's phones light their message-waiting indicator (MWI),
which counts the unread messages; a `voicemail.new` event goes out (`webhooks`); and, with a mail
relay, the voicemail mail with the audio attached goes to the user, or to every member of the
ring group (`mail-templates`).

**Reading them.** All voicemail operations are role `user`: a user sees their own mailbox and
those of the ring groups they are a member of, directly or through a user group; an admin sees
every mailbox.

- `voicemails.list` (`GET /api/v1/voicemails`) lists them newest first, paginated, each with its
  mailbox (`mailboxUserId` or `mailboxRingGroupId`), `caller`, `durationS`, `read` and `createdAt`.
- `voicemails.audio` (`GET /api/v1/voicemails/{id}/audio`) returns the recording, the stored WAV, or
  with `format` `mp3` or `opus` a compressed transcode. As an MCP tool it returns
  `{ url, expiresAt }` instead: a link to that endpoint that opens without a token for five
  minutes, to hand to whatever plays or downloads the file. `recordings.audio` does the same.
- `voicemails.markRead` (`PATCH /api/v1/voicemails/{id}`) with `{ "read": true }`, or `false` to
  mark it unread again; the MWI follows. Read flags are not audited.
- `voicemails.delete` (`DELETE /api/v1/voicemails/{id}`) removes the message and its audio for good:
  it asks for confirmation (`guardrails`) and cannot be undone.

On the phone, `*96` opens one's own mailbox and `*95<ext>` the mailbox of that extension's user
or ring group, for its owner or a member: play and delete messages, and on `*96` record the
personal greeting. Voicemails
are kept until someone deletes them; no retention job removes them.

## Presence history

Every change of a user's presence, `available`, `busy`, `offline` or `dnd`, is logged with the
time it began and, while busy, the other party (`peer`) and the ring group that routed the call
(`ringGroupId`). The same transition is the `presence` event (`webhooks`).

`presenceLog.snapshot` (`GET /api/v1/presence/log?at=&userId=`, `admin`) answers what everyone's
status was at instant `at`: for each user, the last logged state at or before it, with its `since`.
`userId` narrows it to one user; the snapshot is paged by user like every list. `at` is an ISO 8601
time with any offset (`2026-10-01T11:00:00+02:00`, `2026-10-01T09:00Z`; in a query string, write the
`+` as `%2B`), seconds optional, or without one, `2026-10-01T11:00`, a local time in the tenant's
time zone (`settings.timezone`); a date alone is its local midnight, and a local time that a
daylight-saving change skips or repeats is the earlier of its two possible instants. The `from` and
`to` of `calls.list`, `audit.list` and `stats.query` read the same way, as the range from `from` up
to but not including `to`; a date alone as `to` covers that whole day, so
`from=2026-10-01&to=2026-10-01` is that day. The log is purged after
`settings.recordingRetentionDays` (default 90), so a user whose last change is older than that is
missing from a snapshot.

## Statistics

`stats.query` (`GET /api/v1/stats?metric=&from=&to=&bucket=&ringGroupId=`, `admin`) computes one
metric over the finished calls of the history, on demand; there are no precomputed totals.

| `metric`        | Value per bucket                                                   |
| --------------- | ------------------------------------------------------------------ |
| `callVolume`    | the number of calls                                                |
| `answerRate`    | answered calls divided by answered, missed and busy ones, 0 to 1   |
| `ringToAnswer`  | the mean seconds from a call's start to its answer, answered calls |
| `avgCallLength` | the mean seconds from answer to end, answered calls                |

- `from` (inclusive) and `to` (exclusive) are read like the time filters above, local times and
  dates included; a call counts by its start time.
- `bucket` is `minute`, `hour`, `day` or `week`, aligned to the tenant time zone
  (`settings.timezone`): an hour starts on the local hour, a day at local midnight, a week at
  local Monday midnight, so a day across a daylight-saving change lasts 23 or 25 hours, and the
  first bucket can start before `from`. Changing the time zone re-buckets every call on the next
  query. At most 10080 buckets per
  request, a week by minute or about a year by hour; a wider range is refused with 422.
- Without `ringGroupId`, each call counts once, as the caller saw it: a transfer or three-way leg
  is part of its call, not a call of its own, and a transferred call's length ends at the
  transfer. A call is answered when its status is `answered`.
- With `ringGroupId`, each offer to that group counts, a call transferred into it included: it is
  answered when a member of the group took it, its ring time runs until that member answered,
  and its length is that member's part of the call. An offer only an announcement answered is
  not answered.

The answer is `{ "buckets": [{ "start": "…", "value": … }] }`, one entry per bucket, `value`
`null` where there is nothing to average or divide. Voicemail, blocked, failed and interrupted
calls count toward `callVolume` but are left out of `answerRate`.
