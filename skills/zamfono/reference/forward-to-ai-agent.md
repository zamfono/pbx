---
title: Forward calls to an AI agent (OpenAI Realtime)
arguments:
  - name: projectId
    description: The OpenAI project id the agent answers for, `proj_…`
    required: true
  - name: forwardFrom
    description: What sends calls to the agent, a DID, a user's forwarding rule or another target
    required: true
---

# Forward calls to an AI agent (OpenAI Realtime)

OpenAI's Realtime API answers phone calls over SIP: an INVITE to
`sip:<project id>@sip.api.openai.com;transport=tls`, on port 5061 over TLS, with SRTP media and
Opus. OpenAI then calls a webhook of yours (`realtime.call.incoming`), and your service accepts
the call and tells the model what to do. That webhook and the accept call are your own service,
outside the stack; this recipe gets the call to OpenAI. OpenAI's guide:
<https://developers.openai.com/api/docs/guides/realtime-sip>.

1. Create a trunk for the endpoint: `trunks.create` (`POST /trunks`) with
   - `"name": "OpenAI Realtime"`, `"emergency": false` (it carries no emergency calls),
     `"authMode": "ip"`;
   - `"transport": "tls"`, `"tlsVerify": true` (OpenAI presents a publicly trusted certificate;
     turn it off only for a test endpoint with a self-signed one) and `"srtp": true`, which OpenAI
     requires;
   - `"codecs": ["opus", "alaw", "ulaw"]`, Opus first;
   - `"hosts": [{ "host": "sip.api.openai.com", "port": 5061, "direction": "outbound" }]`:
     `outbound`, since OpenAI never calls the stack, and the port given, since the endpoint is
     reached on 5061 directly.

   The trunk needs no outbound route, and should get none: a `sip` target dials it directly, and
   a route would let ordinary outbound calls leave over it. If it is the tenant's first trunk, the
   catch-all route created with it points at it; move that route to the carrier's trunk with
   `outboundRoutes.replace` (`PUT /outboundRoutes`). Check the trunk's `status` with `trunks.get`
   (`GET /trunks/{id}`) a minute after creating it: an `ip` trunk whose host does not answer the
   stack's OPTIONS probe, sent every 60 seconds, turns `unreachable`, and calls are then not sent
   to it. If it stays `unreachable` although OpenAI takes calls, the endpoint ignores OPTIONS:
   a test call (step 6) then shows an `attempt` line with the cause `unreachable` and no SIP
   code, since no INVITE was sent. Switch the probe off with `trunks.update`
   (`PATCH /trunks/{id}`) and `"qualify": false`; the trunk then reads `unmonitored`, every call
   is sent to it, and a call OpenAI refuses fails with OpenAI's own answer. Leave `qualify` on
   while the trunk reads `registered`: it is what tells you the endpoint is down.

2. Point a forward target at the agent: `{ "kind": "sip", "trunkId": "<the trunk's id>", "user":
"<project id>" }`. The `user` is the part before the `@`, 1 to 64 letters, digits and
   `. _ ~ + -`. It works wherever a target does, for example
   - a number answered by the agent: `dids.update` (`PATCH /dids/{id}`) with it as `target`;
   - a person's calls when they do not pick up: `users.setForwarding`
     (`PUT /users/{id}/forwarding`) with a `noAnswer` rule to it;
   - an out-of-office rule, closed opening hours, a menu option or a ring group's fallback.

   Only an admin or owner sets one; a user editing their own out-of-office rule or opening hours is
   refused with 403 for it. The trunk cannot be deleted while a target dials over it.

3. Choose what the call tells your webhook. The target's `headers` lists the SIP headers the
   INVITE carries, each a `name` and a `value`:

   ```json
   {
     "kind": "sip",
     "trunkId": "<the trunk's id>",
     "user": "<project id>",
     "headers": [
       { "name": "X-Zamfono-Caller", "value": "{{callerNumber}}" },
       { "name": "X-Zamfono-Did", "value": "{{did}}" },
       { "name": "X-Called", "value": "{{calledExtension}} {{calledName}}" },
       {
         "name": "X-Forwarded",
         "value": "{{forwardedByName}}: {{forwardReason}}"
       }
     ]
   }
   ```

   A name starts with `X-` and has up to 64 letters, digits and dashes after it, each name once. A
   value is text with placeholders in double braces, filled in for each call:

   | Placeholder                | Filled with                                                                             |
   | -------------------------- | --------------------------------------------------------------------------------------- |
   | `{{callerNumber}}`         | the caller's number (`+43…`), or a colleague's extension; empty when withheld           |
   | `{{callerName}}`           | the caller's name from the phone book, else a colleague's own name, else empty          |
   | `{{did}}`                  | the company number an outside caller dialled; empty for an internal call                |
   | `{{calledExtension}}`      | the extension of the user or ring group the call was for                                |
   | `{{calledName}}`           | that user's or ring group's name                                                        |
   | `{{forwardedByExtension}}` | the extension of the user or ring group that forwarded the call last                    |
   | `{{forwardedByName}}`      | their name                                                                              |
   | `{{forwardReason}}`        | why: `outOfOffice`, `closed`, `unconditional`, `busy`, `noAnswer`, `unavailable`, `dnd` |
   | `{{hopCount}}`             | how many times the call was forwarded                                                   |
   | `{{callId}}`               | the call's id, as `calls.get` (`GET /calls/{id}`) knows it                              |
   | `{{direction}}`            | `inbound` or `internal`                                                                 |
   | `{{language}}`             | the company's language, such as `de`                                                    |
   | `{{startedAt}}`            | when the call started, such as `2026-09-30T12:00:00.000Z`                               |

   A header whose value comes out empty is left out: a caller who withheld their number sends no
   `X-Zamfono-Caller`. Each value is at most 256 bytes, and the headers together at most 2048 by
   their longest possible values; anything else in braces, or a header named twice, is refused
   with 422. Left out, `headers` is the first two above; `[]` sends none. On a trunk whose
   `transport` is `udp` a write whose headers could make the INVITE too large for one UDP packet
   is accepted with a warning; OpenAI's trunk is TLS and has no such limit.

   A call that user A's out-of-office rule sent to user B, whose rule sent it on to the agent,
   has A as `{{calledName}}`, B as `{{forwardedByName}}` and `unconditional` as
   `{{forwardReason}}`.

4. Let the media through. OpenAI sends and receives its SRTP audio from 13.79.45.80/28,
   23.98.140.64/28, 40.67.149.176/28 and 40.83.204.240/28; a firewall in front of the stack must
   let those reach the RTP port range as well as the signalling on 5061.

5. What your webhook sees. The INVITE's request URI is
   `sip:<project id>@sip.api.openai.com:5061`, its `To` `<sip:<project id>@sip.api.openai.com>`,
   and its `From` the number the stack presents, as for any call over
   the trunk: the forwarding user's own number, else the company's main number. It adds
   - the target's headers, as step 3 sets them;
   - `Diversion`: the user or ring group whose rule forwarded the call last, with their number
     (their own number, else their extension), name and reason: `unconditional`, `user-busy`,
     `no-answer`, `unavailable`, `do-not-disturb`, `away` (out of office) or `time-of-day` (closed
     hours). Only the last forward is named: a call that user A's out-of-office rule sent to user
     B, whose rule sent it on to the agent, names B, for example
     `Diversion: "B Name" <sip:178@203.0.113.10>;reason=unconditional`.

   A call from a DID straight to the agent carries no `Diversion`, since nobody forwarded it.

6. Test it: call the number, then read the call with `calls.get` (`GET /calls/{id}`). Its trace
   has one `attempt` line with `"routeId": null`, the trunk's id and the outcome (`answered`, or
   the SIP code OpenAI refused with). A `sipTarget` line with `trunkMissing` or `noOutboundHost`
   means the trunk was deleted or lost its outbound host, and the call was released with 503.
