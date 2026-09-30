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
   (`GET /trunks/{id}`): an `ip` trunk whose host stops answering the stack's OPTIONS probe turns
   `unreachable`, and calls are then not sent to it.

2. Point a forward target at the agent: `{ "kind": "sip", "trunkId": "<the trunk's id>", "user":
"<project id>" }`. The `user` is the part before the `@`, 1 to 64 letters, digits and
   `. _ ~ + -`. It works wherever a target does, for example
   - a number answered by the agent: `dids.update` (`PATCH /dids/{id}`) with it as `target`;
   - a person's calls when they do not pick up: `users.setForwarding`
     (`PUT /users/{id}/forwarding`) with a `noAnswer` rule to it;
   - an out-of-office rule, closed opening hours, a menu option or a ring group's fallback.

   Only an admin or owner sets one; a user editing their own out-of-office rule or opening hours is
   refused with 403 for it. The trunk cannot be deleted while a target dials over it.

3. Let the media through. OpenAI sends and receives its SRTP audio from 13.79.45.80/28,
   23.98.140.64/28, 40.67.149.176/28 and 40.83.204.240/28; a firewall in front of the stack must
   let those reach the RTP port range as well as the signalling on 5061.

4. What your webhook sees. The INVITE's request URI is
   `sip:<project id>@sip.api.openai.com:5061`, its `To` `<sip:<project id>@sip.api.openai.com>`,
   and its `From` the number the stack presents, as for any call over
   the trunk: the forwarding user's own number, else the company's main number. It adds
   - `X-Zamfono-Caller`: the original caller, in the international form (`+43…`), or a
     colleague's extension; left out when the caller withheld their number;
   - `X-Zamfono-Did`: the company number an outside caller dialled; left out for an internal call;
   - `Diversion`: the user or ring group whose rule forwarded the call last, with their number
     (their own number, else their extension), name and reason: `unconditional`, `user-busy`,
     `no-answer`, `unavailable`, `do-not-disturb`, `away` (out of office) or `time-of-day` (closed
     hours). Only the last forward is named: a call that user A's out-of-office rule sent to user
     B, whose rule sent it on to the agent, names B, for example
     `Diversion: "B Name" <sip:178@203.0.113.10>;reason=unconditional`.

   A call from a DID straight to the agent carries no `Diversion`, since nobody forwarded it.

5. Test it: call the number, then read the call with `calls.get` (`GET /calls/{id}`). Its trace
   has one `attempt` line with `"routeId": null`, the trunk's id and the outcome (`answered`, or
   the SIP code OpenAI refused with). A `sipTarget` line with `trunkMissing` or `noOutboundHost`
   means the trunk was deleted or lost its outbound host, and the call was released with 503.
