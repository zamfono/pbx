# HTTP requests in a call flow

An **HTTP request** asks an outside system something while a call is on its way, and the call
then goes on by the answer: a CRM that knows the caller is a VIP, an availability service that
knows who is on shift, a ticket system that knows there is an open case. It is a target like a
decision or a menu, `{ "kind": "httpRequest", "httpRequestId": "…" }`, so a DID, a menu option
or a forward rule can point at one. Only an admin sets one; a user reads it on their own
forwarding as `{ "managed": true, "kind": "httpRequest" }` (`guardrails`).

## Create one

`httpRequests.create` (`POST /api/v1/httpRequests`):

```json
{
  "name": "crm",
  "request": {
    "method": "GET",
    "url": "https://crm.example/api/customers?phone={{callerNumber}}",
    "headers": [
      { "name": "Authorization", "value": "Bearer …", "secret": true }
    ]
  },
  "timeoutS": 3,
  "target": { "kind": "decision", "decisionId": "…by tier" },
  "errorTarget": { "kind": "ringGroup", "ringGroupId": "…reception" }
}
```

- `name` is how templates read the answer, `{{crm.…}}`: a letter, then letters, digits or `_`,
  unique, and none of the placeholders or helpers (`templates`).
- `request` is the request: `method` (`GET` unless given, `POST`, `PUT`, `PATCH`, `DELETE`), `url`,
  `headers`, and for a method with a body `body` and its `contentType` (`application/json`,
  `application/x-www-form-urlencoded` or `text/plain`). URL, header values and body are templates
  (`templates`). A header with `"secret": true` is stored encrypted and read back without its
  value, as `"secretSet": true`; written without a `value`, it keeps the stored one. With a
  `secret` the request carries `X-Zamfono-Signature` as a webhook does (`webhooks`); `null`
  removes it.
- `timeoutS` is how long the answer may take, 5 seconds unless given. The caller waits that long
  at most.
- `target` is where the call goes after an answer, `errorTarget` where it goes without one.

`httpRequests.update` (`PATCH /api/v1/httpRequests/{id}`) changes any of these, `request` as a
whole; `httpRequests.list` and `httpRequests.get` read them back; `httpRequests.delete` is refused
while a target still points at the request.

## What happens on a call

The caller hears ringing and is not answered while the request runs. A `2xx` answer whose body is
JSON, up to 64 KiB, is kept for the rest of the call under the request's name, and the call goes
to `target`. Anything else sends it to `errorTarget`: another status, a body that is no JSON or
larger, a timeout, a failed connection or an address the stack may not connect to (the rules of
`webhooks`, plain `http://` only to a private address). The request is sent once, never retried,
since somebody is waiting.

Route on the answer with a decision's `template` condition (`decisions`):

```json
{
  "name": "by tier",
  "cases": [
    {
      "when": [
        { "type": "template", "template": "{{crm.data.tier}}", "equals": "vip" }
      ],
      "target": { "kind": "user", "userId": "…account manager" }
    }
  ],
  "default": { "kind": "ringGroup", "ringGroupId": "…support" }
}
```

or use it directly, `{ "kind": "extension", "extension": "{{crm.data.agentExtension}}" }`. A
target behind the request can send it on too: a `sip` target's header `{{crm.data.id}}`, a voice
bot's URL. An answer lives in memory for the call it was fetched for and is stored nowhere.

A request counts no forwarding hop. A call that reaches the same request twice with nothing in
between — no ring of a user or group through a forward, no forward rule, no menu key — ends as
at the forwarding limit, like a decision met twice (`decisions`).

## Checking it

The call trace (`calls.get`, `diagnose-bad-call`) has an `httpRequest` line per request: the
method, the URL without its query, the status or the kind of error (`HTTP 404`, `no JSON`,
`timeout`, `forbidden address`, `response too large`, …) and how long it took. Headers, the
query and bodies are never logged, since they carry tokens and personal data.
