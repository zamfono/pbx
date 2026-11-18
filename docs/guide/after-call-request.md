# After-call requests

An **after-call request** tells a system of yours that a forwarded call is over: an HTTP request
sent after each attempt of an `external`, `sip` or `webSocket` target, carrying the call's record
and, if you ask for them, links to its recordings. It is how a CRM gets its call entry, a ticket
its transcript job, an archive the recording, without polling `calls.list` or reading the call
trace. Only an admin sets one; a user sees a target that has one as its marker (`guardrails`).

## Set one

`afterCall` on the target, wherever the target is set:

```json
{
  "kind": "external",
  "external": "+4366412345",
  "record": true,
  "afterCall": {
    "url": "https://crm.example/hooks/calls",
    "secret": "a long random string",
    "headers": [
      { "name": "Authorization", "value": "Bearer …", "secret": true },
      { "name": "X-Called", "value": "{{did}}" }
    ],
    "recordings": ["download", "delete"]
  }
}
```

- `url`, `headers`, `method`, `body` and `contentType` are an HTTP request as in `http-requests`,
  templates included (`templates`). `method` is `POST` unless given.
- `secret` signs the request: `X-Zamfono-Signature`, checked as a webhook's (`webhooks`).
- `recordings` asks for a link per recording: `download`, `delete` or both. Left out, the record
  lists the recordings without links.

A read returns the request with `"secretSet": true`, secret headers without their values, and its
delivery status. Write back what you read to change something else on the target: the target
stays the same one, so the request keeps its delivery status, and its secret and secret header
values wherever the write leaves them out. A new target needs its `secret`: a rule or key added,
or a target copied to another place, keeps nothing from the one it was read from, and is refused
with 422 without it. Writing the target without `afterCall`, or with `"afterCall": null`, removes
the request and its secrets. A change that sets a secret, drops a secret header or removes the
request cannot be undone (`guardrails`); any other change to the target can.

## When it is sent

After **every attempt** of the target: answered, busy, failed, timed out, or given up for its
fallback. Each target of a fallback chain reports its own attempt, and so does a ring-group
member's forward to such a target and a party added to a call through it.

The request goes out once the call has ended and its recordings are written, which is a little
after hangup, since a recording is mixed first. Delivery is a webhook's: three attempts, 1 s and
4 s apart, a 5 s timeout, no redirect followed, the same rules for the receiver's address, and
`lastStatus`, `lastError`, `failingSince` and `failedDeliveries` on the request as `webhooks`
describes them for a hook. It is at least once: deduplicate on the call's `id` and the target's
`startedAt`.

## The call record

Without a `body`, the request is a `POST` of this JSON:

```json
{
  "id": "0198c2d4-…",
  "parentCallId": null,
  "direction": "inbound",
  "fromUri": "+4369912345",
  "toUri": "+4315550117",
  "didId": "…",
  "callerUserId": null,
  "calleeUserId": null,
  "ringGroupId": null,
  "answeredByUserId": null,
  "status": "answered",
  "startedAt": "2026-11-18T10:00:00.000Z",
  "answeredAt": "2026-11-18T10:00:09.000Z",
  "endedAt": "2026-11-18T10:01:00.000Z",
  "qos": [],
  "childCallIds": [],
  "recordings": [
    {
      "id": "…",
      "userId": null,
      "durationS": 51,
      "createdAt": "2026-11-18T10:01:01.000Z",
      "downloadUrl": "https://pbx.example.com/api/v1/recordings/…/audio?access_token=…",
      "deleteUrl": "https://pbx.example.com/api/v1/recordings/…?access_token=…"
    }
  ],
  "target": {
    "forwardTargetId": "…",
    "kind": "external",
    "external": "+4366412345",
    "outcome": "answered",
    "cause": null,
    "startedAt": "2026-11-18T10:00:01.000Z",
    "endedAt": "2026-11-18T10:00:09.000Z"
  }
}
```

The call is what `calls.get` returns (`call-data`), without its `log`. `target` is the attempt:
the number dialled, or a `sip` target's `trunkId` and `user`; a voice bot's URL is left out, since
it carries the bot's token. `outcome` is `answered`, `failed`, or `cancelled` for a ring-group
member's forward that was still ringing when the group's ring ended. `cause` says why a target
did not answer: the far end's SIP status (`486`), or `noRoute`, `ringTimeout`, `trunkMissing`,
`noOutboundHost`, `connectFailed`, `forbiddenAddress`, `mediaFailed`, `templateInvalid`,
`callerGone`.

With a `body`, the request sends that instead, and the record's fields are placeholders under
`cdr`: `{{cdr.fromUri}}`, `{{cdr.target.outcome}}`, `{{cdr.recordings.0.downloadUrl}}`. The
call's own placeholders keep the values they had at the attempt.

```json
{
  "url": "https://chat.example/hooks/abc",
  "secret": "…",
  "body": "{\"text\":\"Call from {{callerNumber}} to {{cdr.target.external}}: {{cdr.target.outcome}}\"}",
  "contentType": "application/json"
}
```

## Recording links

A `downloadUrl` answers the recording's audio to a `GET`, the stored WAV or with `&format=mp3` or
`&format=opus` a smaller file. A `deleteUrl` removes the recording to a `DELETE`, at once and for
good: there is no undo, as for any recording (`call-data`). Each link is for that one recording,
valid for one hour, and made fresh for every delivery attempt; it needs no other login, so treat
the request body as a credential and send it over `https://`. A delete through a link is in the
audit log as the after-call request of its forward target. A recording that was not made, because
the media storage was full, is simply not in the list (`call-data`).
