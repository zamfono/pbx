---
title: Forward calls to a voice bot over a WebSocket (Twilio Media Streams or Vonage)
arguments:
  - name: url
    description: The bot's WebSocket URL, `wss://…`, with any token it checks in the query string
    required: true
  - name: protocol
    description: What the bot speaks, `twilio` (Twilio Media Streams) or `vonage` (the Vonage Voice API WebSocket)
    required: true
  - name: forwardFrom
    description: What sends calls to the bot, a DID, a user's forwarding rule or another target
    required: true
---

# Forward calls to a voice bot over a WebSocket (Twilio Media Streams or Vonage)

Many voice bots take a phone call over a WebSocket rather than SIP: the telephony side streams
the caller's audio to the bot, and plays what the bot sends back. Bots built with Pipecat,
LiveKit's agents or your own code usually speak one of two protocols, Twilio's Media Streams or
the Vonage Voice API WebSocket, and the stack speaks both. A bot reached over SIP, such as
OpenAI's Realtime API, is `forward-to-ai-agent` instead.

1. Choose the protocol the bot speaks:

   | `protocol` | Frames                                        | Audio                                       |
   | ---------- | --------------------------------------------- | ------------------------------------------- |
   | `twilio`   | JSON text, the audio base64 inside            | μ-law at 8 kHz, always                      |
   | `vonage`   | one JSON text frame, then binary audio frames | 16-bit little-endian PCM at 8, 16 or 24 kHz |

   `twilio` is what most bot frameworks accept as "Twilio" (Pipecat's `TwilioFrameSerializer`, for
   example); `vonage` sounds better, at 16 kHz unless you say otherwise.

2. Point a forward target at the bot:

   ```json
   {
     "kind": "webSocket",
     "protocol": "vonage",
     "url": "wss://bot.example.com/calls?token=…",
     "sampleRate": 16000
   }
   ```

   `url` is `wss://` (or `ws://` on a network you trust), at most 2048 characters; the stack sends
   no headers of its own on the handshake, so a token the bot checks goes in the query string.
   `sampleRate` is 8000, 16000 or 24000 for `vonage`, 16000 unless given, and always 8000 for
   `twilio`. The target works wherever a target does, for example
   - a number answered by the bot: `dids.update` (`PATCH /api/v1/dids/{id}`) with it as `target`;
   - a person's calls when they do not pick up: `users.setForwarding`
     (`PUT /api/v1/users/{id}/forwarding`) with a `noAnswer` rule to it;
   - an out-of-office rule, closed opening hours, a menu option or a ring group's fallback.

   A ring-group member's own forward to a bot skips the member instead of ringing the bot. Only an
   admin or owner sets one, as for a `sip` target (`guardrails`), since it sends the call's audio
   to whatever URL it names. Add `"record": true` to record every call the bot answers.

3. What the bot receives. The stack opens the WebSocket while the caller still waits, and answers
   the caller once it is open. Then:
   - `twilio`: `connected`, then `start` with `callSid` (the call's id, as `calls.get` knows it),
     `streamSid`, `mediaFormat` (`audio/x-mulaw`, 8000, 1 channel) and the call's details as
     `customParameters`; then the caller's audio as `media` frames, one per 20 ms, `dtmf` for each
     key the caller presses, and `stop` as the call ends.
   - `vonage`: `websocket:connected` with `content-type` (`audio/l16;rate=16000`) and the call's
     details as its properties; then the caller's audio as binary frames, one per 20 ms, and
     `websocket:dtmf` with the digit and its duration for each key pressed.

   The call's details, each left out when empty:

   | Name                                      | Value                                                                           |
   | ----------------------------------------- | ------------------------------------------------------------------------------- |
   | `callerNumber`, `callerName`              | the caller's number and name, as a `sip` target's headers have them             |
   | `did`                                     | the company number an outside caller dialled                                    |
   | `calledExtension`, `calledName`           | the user or ring group the call was for                                         |
   | `forwardedByExtension`, `forwardedByName` | who forwarded the call last, and `forwardReason` why                            |
   | `hopCount`, `direction`, `language`       | as for a `sip` target's headers                                                 |
   | `callId`, `startedAt`                     | the call's id and when it started                                               |
   | `apiUrl`                                  | the stack's API, `https://<your domain>/api/v1`                                 |
   | `sessionToken`                            | the token the bot acts on this call with (step 5)                               |
   | `callerLegId`, `botLegId`                 | the caller's leg and the bot's own, as `calls.list` with `live=true` lists them |

4. What the bot sends. Its audio is played to the caller at the call's own pace, however fast it
   arrives, up to about a minute ahead:
   - `twilio`: `media` with base64 μ-law, any length; `mark` with a `name`, sent back once the
     audio before it has played; `clear`, which drops the audio not yet played and sends back the
     marks dropped with it, so the bot can stop talking when the caller interrupts.
   - `vonage`: binary PCM in the call's format; `{"action":"notify","payload":{…}}`, answered
     with `websocket:notify` and the payload once the audio before it has played;
     `{"action":"clear"}`, answered with `websocket:cleared`.

5. Acting on the call. The bot sends `sessionToken` as a bearer token to the stack's API at
   `apiUrl`, for its own call only and only while it is connected; any other call or operation is
   refused with 403. It names the caller's leg, since the bot is nobody's other party:
   - to hang up: `calls.hangup` (`POST /api/v1/calls/{id}/hangup`) with the call's id
     (`callSid`, or `callId`);
   - to hand the caller to a person: `calls.transfer` (`POST /api/v1/calls/{id}/transfer`) with
     `"target": "102"` and `"legId": <callerLegId>`; the bot's own leg is released;
   - to hold, resume or park the caller: `calls.hold`, `calls.resume` and `calls.park` the same
     way.

   A bot that ends a call through Twilio's own API, such as Pipecat's `TwilioFrameSerializer` with
   its default `auto_hang_up`, should not: set `auto_hang_up` off and close the socket, or call
   `calls.hangup`.

6. How the call ends. The bot closing its socket hangs up the caller. The caller hanging up, or a
   transfer away from the bot, closes the socket, after `stop` for `twilio`. A socket that does not
   open within 10 seconds, or that the bot refuses, releases the caller with 503.

7. Let the connection through. The stack connects out to the bot from its host, so a firewall in
   front of the stack must let it reach the bot's address and port; the audio travels inside that
   connection, and takes no RTP port of the stack's.

8. Test it: call the number, then read the call with `calls.get` (`GET /api/v1/calls/{id}`). Its
   trace has an `answered` line with `"leg": "webSocket"` and the protocol. A `webSocket` line
   with `connectFailed` means the socket did not open (a wrong URL, a refused token, a
   certificate the stack does not trust); `mediaFailed` means the stack could not set up the
   audio, which its logs explain.
