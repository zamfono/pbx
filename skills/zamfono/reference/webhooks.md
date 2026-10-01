# Webhooks

A webhook is an HTTP endpoint the stack POSTs every realtime event to, or the event types it is
filtered to: presence changes, call state, new voicemail, OOO and opening-hours transitions, trunk
status, finished calls and backups. It is how a CRM, a wallboard or a ticketing system follows
the phone system without polling. The same events stream to a WebSocket at `/events` for a client
that keeps a connection open.

## Managing webhooks

All webhook operations are `admin`.

- `webhooks.create` (`POST /webhooks`) takes `url` (`http` or `https`), `secret` (any non-empty
  string, write-only) and an optional `eventTypes` filter. A new hook is always created
  **inactive**, so nothing is POSTed to a receiver that is not deployed yet.
- `webhooks.update` (`PATCH /webhooks/{id}`) changes `url`, `secret` or `eventTypes`, and switches
  delivery on and off with `active`. `{ "active": true }` once the receiver verifies signatures.
- `webhooks.list` (`GET /webhooks`) lists the hooks with `eventTypes`, `active`, `lastStatus` and
  `lastDeliveryAt`; the secret never appears in a read.
- `webhooks.delete` (`DELETE /webhooks/{id}`) soft-deletes a hook (`guardrails`); nothing more is
  delivered to it.

`eventTypes` is a list of the type names below, such as `["call.state", "voicemail.new"]`; `null`
or left out delivers every event. On `webhooks.update`, `null` clears the filter and leaving the
field out keeps it. A hook receives every event its filter admits, whatever role created it: the
per-role visibility of `/events` does not apply.

## Events and payloads

Every event is one JSON object with `type`, a unique `id` (UUIDv7) and `at` (ISO 8601, UTC), plus
the fields of its type:

| `type`             | Fields                                                                            | When                                                      |
| ------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `presence`         | `userId`, `status` (`available`, `busy`, `offline`, `dnd`), `peer`, `ringGroupId` | a user's presence changes; `peer` and group while busy    |
| `call.state`       | `callId`, `state` (`ringing`, `up`, `ended`), `peer`, `ringGroupId`, `userId`     | a call starts ringing, is answered or ends                |
| `voicemail.new`    | `voicemailId`, `mailbox` (`user:<id>` or `ringGroup:<id>`)                        | a message is left (`call-data`)                           |
| `ooo`              | `scope`, `active`, `startsAt`, `expiresAt`                                        | an out-of-office rule starts or ends                      |
| `hours`            | `scope`, `open`                                                                   | an opening-hours interval opens or closes                 |
| `trunk.status`     | `trunkId`, `status` (`registered`, `unreachable`, `unmonitored`, `unknown`)       | a trunk's status changes                                  |
| `history.appended` | `callId`                                                                          | a call's history row is written; read it with `calls.get` |
| `backup.started`   | `targetId`, `runId`                                                               | a backup run starts                                       |
| `backup.finished`  | `targetId`, `runId`, `snapshotId`, `bytesAdded`, `bytesTotal`, `durationS`        | a backup run succeeds                                     |
| `backup.failed`    | `targetId`, `runId`, `error`                                                      | a backup run fails                                        |

A `scope` is `tenant`, `user:<id>`, `ringGroup:<id>` or `menu:<id>`. `peer` is the other party
as the routing pipeline sees it: an extension, an international number, a provider's verbatim
string or `anonymous`. Fields that do not apply are `null`.

```json
{
  "type": "call.state",
  "id": "0198c2d4-7b1e-7c3a-9f00-2b4d6e8a1c3f",
  "at": "2026-10-01T09:14:03.512Z",
  "callId": "0198c2d4-…",
  "state": "ringing",
  "peer": "+4930123456",
  "ringGroupId": "0198b7c1-…",
  "userId": null
}
```

## Delivery

Each event is one `POST` to the hook's `url` with `Content-Type: application/json`, the event as
the body and an `X-Zamfono-Signature` header.

- A delivery succeeds on any `2xx` answer within 5 seconds. A connection error, another status or
  a timeout fails the attempt; after three attempts, 1 s and then 4 s apart, the delivery is
  given up.
- `lastStatus` in `webhooks.list` is `ok` after a delivery that succeeded and `failing` after one
  that gave up, with `lastDeliveryAt` its time; `null` before the first. A failing hook stays
  active and keeps receiving new events: it is never switched off automatically.
- Delivery is **at least once**: a receiver that answers too slowly can get the same event again.
  Deduplicate on `id`. Events are delivered concurrently, so order them by `at`, not by arrival.
- Pending deliveries are kept in the database: a delivery queued or between retries when the
  `api` container restarts (an update, a crash) goes on after it, with the attempts it has left,
  and one cut off mid-request is sent again. Deleting a hook drops its pending deliveries. An
  event that happens while `api` is down reaches no webhook, so treat a webhook as a
  notification and re-read state through the API (`calls.list`, `voicemails.list`, …) after a
  gap.

## Verifying the signature

`X-Zamfono-Signature` is the HMAC-SHA256 of the **raw request body**, keyed with the hook's
`secret` as UTF-8 text, written as 64 lowercase hex digits with no prefix. Compute it over the
bytes exactly as received, before any JSON parsing, and compare in constant time:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verified(rawBody, signature, secret) {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const given = Buffer.from(String(signature ?? ''));
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}
```

```python
import hashlib, hmac

def verified(raw_body: bytes, signature: str, secret: str) -> bool:
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature or "")
```

Reject a request that fails the check. The signature covers the body only and carries no
timestamp, so a replayed request verifies again; the `id` deduplication above is what turns it
away. To rotate the secret, `webhooks.update` with a new `secret`: the next delivery is signed
with it, and the change is audited with the value masked and cannot be undone (`guardrails`).
