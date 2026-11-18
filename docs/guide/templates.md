# Templates

A **template** is text with placeholders in double braces that the stack fills in for each call.
A forward target's address, a `sip` target's headers, a decision's condition and an HTTP request's
URL, headers and body can each be one, so that where a call goes and what is sent about it depend
on the call itself: the number that was dialled, who calls, what an outside system answered.

Only an admin writes a template. A number built from what a caller sends is a way to place calls
at the company's cost, so a user's own forwarding stays a fixed number or colleague, and a user
reads a templated target as its marker (`guardrails`).

## Placeholders

| Placeholder                | Filled with                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `{{callerNumber}}`         | the caller's number (`+43…`), or a colleague's extension; empty when withheld           |
| `{{callerName}}`           | the caller's name from the phone book, else a colleague's own name, else empty          |
| `{{did}}`                  | the company number an outside caller dialled; empty for an internal call                |
| `{{calledExtension}}`      | the extension of the user or ring group the call was for, empty when it has none        |
| `{{calledName}}`           | that user's or ring group's name                                                        |
| `{{forwardedByExtension}}` | the extension of the user or ring group that forwarded the call last, empty without one |
| `{{forwardedByName}}`      | their name, or the label of the DID or number block whose target is reached             |
| `{{forwardReason}}`        | why: `outOfOffice`, `closed`, `unconditional`, `busy`, `noAnswer`, `unavailable`, `dnd` |
| `{{hopCount}}`             | how many times the call was forwarded                                                   |
| `{{callId}}`               | the call's id, as `calls.get` (`GET /api/v1/calls/{id}`) knows it                       |
| `{{direction}}`            | `inbound` or `internal`                                                                 |
| `{{language}}`             | the company's language, such as `de`                                                    |
| `{{startedAt}}`            | when the call started, such as `2026-09-30T12:00:00.000Z`                               |

A call that user A's out-of-office rule sent to user B, whose rule sent it on, has A as
`{{calledName}}`, B as `{{forwardedByName}}` and `unconditional` as `{{forwardReason}}`.

The answer of an HTTP request the call passed (`http-requests`) is read under the request's name,
by path: `{{crm.data.tier}}` for a request named `crm` that answered
`{ "data": { "tier": "vip" } }`, `{{crm.items.0.id}}` for the first entry of a list. An after-call
request also reads the call's record under `cdr` (`after-call-request`).

A value that is missing renders empty, and so does a path into something that is not there: a
template never fails a call for a missing value. Text, numbers and `true`/`false` render as
written; an object or a list renders empty.

## Helpers

A placeholder can be passed through a helper, `{{helper value …}}`, and helpers nest in
parentheses:

| Helper                     | Renders                                                                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `slice value start end`    | the characters from `start` up to `end`, which may be left out; negative indexes count from the end: `{{slice did -2}}` is the last two digits |
| `length value`             | how many characters the value has                                                                                                              |
| `replace value from to`    | the value with every `from` replaced by `to`, both literal text                                                                                |
| `stripPrefix value prefix` | the value without `prefix` when it starts with it, else the value                                                                              |
| `digits value`             | only the value's digits: `{{digits callerNumber}}`                                                                                             |

`{{length (digits callerNumber)}}` counts the digits of the caller's number;
`{{replace (stripPrefix did "+43") " " ""}}` chains two. There are no other helpers, no blocks
(`{{#if}}`, `{{#each}}`), no partials and no regular expressions: a write with one is refused with
422, as is a helper with the wrong number of arguments or a name that is neither a placeholder
nor a live HTTP request.

## Where a template goes

| Field                           | Example                                           | A value put in is                   |
| ------------------------------- | ------------------------------------------------- | ----------------------------------- |
| `external` target, `external`   | `+431234567{{slice did -2}}`                      | checked: the result must be E.164   |
| `extension` target, `extension` | `{{slice did -2}}`                                | checked: digits of a live extension |
| `sip` target, `user`            | `queue-{{calledExtension}}`                       | escaped as a SIP user part          |
| `sip` target, header `value`    | `{{callerName}} via {{forwardedByName}}`          | stripped of control characters      |
| `webSocket` target, `url`       | `wss://bot.example/media?caller={{callerNumber}}` | escaped as a URL component          |
| decision condition `template`   | `{{slice did -4}}`                                | compared as it is                   |
| HTTP request `url`              | `https://crm.example/c/{{callerNumber}}`          | escaped as a URL component          |
| HTTP request header `value`     | `Bearer {{crm.token}}`                            | stripped of control characters      |
| HTTP request `body`             | `{"caller":"{{callerNumber}}"}`                   | escaped for the `contentType`       |

Each value is escaped for the place it lands in, so a caller's name with a quote, a line break or
a slash in it cannot change a header, a URL or a JSON body around it. In a body the escaping
follows `contentType`: JSON string escaping for `application/json` (write the quotes around the
placeholder yourself), form encoding for `application/x-www-form-urlencoded`, control characters
stripped for `text/plain`. In a URL the scheme, the host and the port must be written out: a
placeholder may stand anywhere after the host.

In a `sip` target's header a placeholder's value is cut to its own maximum and the whole value to
256 bytes, as before; a helper's result or an HTTP request's answer counts 256 bytes toward the
2048 the headers may take together (`forward-to-ai-agent`).

## The `extension` target

`{ "kind": "extension", "extension": "{{slice did -2}}" }` sends a call to the extension the
template renders, as if the caller had dialled it: a colleague, a ring group, a menu or a
decision, each as that kind of target would be reached. It is how one rule serves a block of
numbers whose last digits are the extension:

```json
{
  "fallbackTarget": {
    "kind": "extension",
    "extension": "{{slice did -2}}",
    "fallback": { "kind": "ringGroup", "ringGroupId": "…reception" }
  }
}
```

on `didBlocks.update` (`PATCH /api/v1/didBlocks/{id}`) forwards +43 1 234 56-17 to extension 17
and every number without an extension to reception. An `external` target stays the kind that
leaves through a trunk and its routes (`numbers`); a fixed colleague or group is named by its own
kind.

## When a template renders nothing usable

A number that is no E.164 number, an extension nobody has, a user part or URL that is none: the
target counts as not working. The call goes to the target's `fallback`, as when a number is busy
(`mental-model`), else it ends unanswered (480). The call trace has a `templateInvalid` line with
the field and what it rendered to (`diagnose-bad-call`), and `decisions.dryRun` shows the same
for values you give it (`decisions`).
