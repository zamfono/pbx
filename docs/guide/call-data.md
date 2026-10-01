# Call data

What the stack records as calls happen, and how to read it: voicemails, the presence history and
the call statistics. The call history itself is `calls.list` (`GET /calls`) and `calls.get`
(`GET /calls/{id}`); its routing trace is in `diagnose-bad-call`.

## Voicemails

**Where they come from.** Every user has a mailbox (`mailboxEnabled`), and a ring group can have
one, off by default. A caller is left in a mailbox when a forward rule or a ring group's fallback
ends there, implicitly when no rule is set and the mailbox is enabled (`routing-order`), or
explicitly through a `mailboxUser` or `mailboxRingGroup` target, which deposits whether or not
the mailbox is enabled. `*97<ext>` puts a caller straight through to a mailbox. The caller hears
the mailbox's greeting, or the default prompt in the tenant language, and records up to
`settings.voicemailMaxS` seconds (default 180), ended by `#` or 5 s of silence.

**What follows a message.** The mailbox's phones light their message-waiting indicator (MWI),
which counts the unread messages; a `voicemail.new` event goes out (`webhooks`); and, with a mail
relay, the voicemail mail with the audio attached goes to the user, or to every member of the
ring group (`mail-templates`).

**Reading them.** All voicemail operations are role `user`: a user sees their own mailbox and
those of the ring groups they are a member of, directly or through a user group; an admin sees
every mailbox.

- `voicemails.list` (`GET /voicemails`) lists them newest first, paginated, each with its mailbox
  (`mailboxUserId` or `mailboxRingGroupId`), `caller`, `durationS`, `read` and `createdAt`.
- `voicemails.audio` (`GET /voicemails/{id}/audio`) returns the recording, the stored WAV, or
  with `format` `mp3` or `opus` a compressed transcode.
- `voicemails.markRead` (`PATCH /voicemails/{id}`) with `{ "read": true }`, or `false` to mark it
  unread again; the MWI follows. Read flags are not audited.
- `voicemails.delete` (`DELETE /voicemails/{id}`) removes the message and its audio for good:
  it asks for confirmation (`guardrails`) and cannot be undone.

On the phone, `*96` opens one's own mailbox and `*95<ext>` the mailbox of that extension's user
or ring group, for its owner or a member: play and delete messages, and on `*96` record the
personal greeting. Voicemails
are kept until someone deletes them; no retention job removes them.

## Presence history

Every change of a user's presence, `available`, `busy`, `offline` or `dnd`, is logged with the
time it began and, while busy, the other party (`peer`) and the ring group that routed the call
(`ringGroupId`). The same transition is the `presence` event (`webhooks`).

`presenceLog.snapshot` (`GET /presence/log?at=&userId=`, `admin`) answers what everyone's status
was at instant `at`: for each user, the last logged state at or before it, with its `since`.
`userId` narrows it to one user. `at` is an ISO 8601 time with any offset
(`2026-10-01T11:00:00+02:00`, `2026-10-01T09:00:00Z`), read as UTC without one; in a query
string, write the `+` as `%2B`. The log is purged after `settings.recordingRetentionDays`
(default 90), so a user whose last change is older than that is missing from a snapshot.

## Statistics

`stats.query` (`GET /stats?metric=&from=&to=&bucket=&ringGroupId=`, `admin`) computes one metric
over the finished calls of the history, on demand; there are no precomputed totals.

| `metric`        | Value per bucket                                                   |
| --------------- | ------------------------------------------------------------------ |
| `callVolume`    | the number of calls                                                |
| `answerRate`    | answered calls divided by answered, missed and busy ones, 0 to 1   |
| `ringToAnswer`  | the mean seconds from a call's start to its answer, answered calls |
| `avgCallLength` | the mean seconds from answer to end, answered calls                |

- `from` (inclusive) and `to` (exclusive) are ISO 8601 timestamps with an offset; a call counts
  by its start time.
- `bucket` is `minute`, `hour`, `day` or `week`, aligned in UTC (a week starts on Monday, a day
  at midnight UTC), so the first bucket can start before `from`. At most 10080 buckets per
  request, a week by minute or about a year by hour; a wider range is refused with 422.
- `ringGroupId` limits the calls to those that group routed.

The answer is `{ "buckets": [{ "start": "…", "value": … }] }`, one entry per bucket, `value`
`null` where there is nothing to average or divide. Every history row counts toward
`callVolume`, transfer and three-way legs included; voicemail, blocked, failed and interrupted
calls are left out of `answerRate`.
