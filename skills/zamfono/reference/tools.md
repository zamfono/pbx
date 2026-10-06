| Operation (MCP tool) | REST | Description | Min role | Confirm |
| --- | --- | --- | --- | --- |
| `audio.create` | `POST /api/v1/audio` | Uploads and transcodes a new audio asset; over MCP, answers with a link to upload the file to. | admin | no |
| `audio.delete` | `DELETE /api/v1/audio/{id}` | Soft-deletes an audio asset. | admin | yes |
| `audio.list` | `GET /api/v1/audio` | Lists the tenant's live audio assets. | admin | no |
| `audio.update` | `PATCH /api/v1/audio/{id}` | Updates an audio asset's label. | admin | no |
| `audit.list` | `GET /api/v1/audit` | Lists audit_log entries, filterable by entity, actor, channel, client, operation, time range and state. | admin | no |
| `audit.undo` | `POST /api/v1/audit/{id}/undo` | Reverts one audit entry by replaying its recorded 'from' values; refused with 409 while a later live change to the same entity exists (zamfono.help undo). | admin | no |
| `backups.runs.get` | `GET /api/v1/backups/runs/{id}` | Reads one backup run's status, snapshot id and sizes | admin | no |
| `backups.runs.list` | `GET /api/v1/backups/runs` | Lists backup runs, newest first | admin | no |
| `backups.runs.start` | `POST /api/v1/backups/runs` | Starts a backup run to one target now, outside the schedule | admin | no |
| `backups.targets.create` | `POST /api/v1/backups/targets` | Adds a backup target, a restic repository every scheduled run (settings.backupCron) backs up to while enabled | admin | no |
| `backups.targets.delete` | `DELETE /api/v1/backups/targets/{id}` | Soft-deletes a backup target; no further run backs up to it | admin | yes |
| `backups.targets.list` | `GET /api/v1/backups/targets` | Lists the tenant's backup targets | admin | no |
| `backups.targets.update` | `PATCH /api/v1/backups/targets/{id}` | Changes a backup target's kind, location, secret or enabled flag | admin | no |
| `blockedNumbers.create` | `POST /api/v1/blockedNumbers` | Adds a number or number prefix to the tenant blocklist; a matching inbound caller is rejected with 603 | admin | no |
| `blockedNumbers.delete` | `DELETE /api/v1/blockedNumbers/{id}` | Removes a number from the tenant blocklist | admin | yes |
| `blockedNumbers.list` | `GET /api/v1/blockedNumbers` | Lists the tenant's inbound blocklist | admin | no |
| `calls.addParty` | `POST /api/v1/calls/{id}/parties` | Three-way call: dials the target from you and, once answered, adds them to a live call so all three talk; returns the added party's own call id (callId). It only rings the target: no forward or mailbox of theirs applies. | user | no |
| `calls.consult` | `POST /api/v1/calls/{id}/consult` | Starts an attended transfer: puts the other party of a live call on hold with hold music and dials the target from you, returning the consultation call's id (callId) for calls.transfer with toCallId. The hold happens in the PBX, so the phone does not show it. | user | no |
| `calls.decline` | `POST /api/v1/calls/{id}/decline` | Declines a call ringing for you, as declining it on your phone would: your phones stop ringing, and the call goes on to your no-answer rule, or a ring group rings its other members. | user | no |
| `calls.get` | `GET /api/v1/calls/{id}` | Reads one call of the history with its log, QoS summary (per leg jitter, loss, round trip and the packets received and sent) and the ids of its child calls. | user | no |
| `calls.hangup` | `POST /api/v1/calls/{id}/hangup` | Hangs up a live call, or with legId one leg of it, as that phone hanging up would. | user | no |
| `calls.hold` | `POST /api/v1/calls/{id}/hold` | Puts the other party of a live call on hold: they hear the hold music, and you and they no longer hear each other; calls.resume ends it. The hold happens in the PBX, so the phone does not show it. Hangup, transfer and park work as usual while held. | user | no |
| `calls.list` | `GET /api/v1/calls` | Lists call history, or the calls currently in progress. | user | no |
| `calls.originate` | `POST /api/v1/calls` | Click-to-dial: rings a user's devices, then dials the target on answer, as that phone would; a parking slot as target retrieves the call parked there. | user | no |
| `calls.park` | `POST /api/v1/calls/{id}/park` | Parks the other party of a live call on the lowest free parking slot, as *70 does, and returns the slot; anyone retrieves it by dialling the slot (calls.originate with the slot as target). | user | no |
| `calls.pickup` | `POST /api/v1/calls/{id}/pickup` | Picks up a call ringing for another party, on the picking user's devices. | user | no |
| `calls.resume` | `POST /api/v1/calls/{id}/resume` | Takes a live call off the hold calls.hold or calls.consult put it on: the held party talks with you again, and during a consultation all three talk. The phone does not show it. | user | no |
| `calls.transfer` | `POST /api/v1/calls/{id}/transfer` | Transfers a live call: blind to an extension or number (target), or with voicemail into an extension's mailbox, where the transferee is routed as a new call; or attended to the consultation calls.consult started (toCallId), where the held party and the consulted party talk on without you. legId names the leg that moves, which an admin not in the call must give. | user | no |
| `contacts.create` | `POST /api/v1/contacts` | Adds a contact to the tenant-wide phone book; its numbers name inbound callers. | admin | no |
| `contacts.delete` | `DELETE /api/v1/contacts/{id}` | Soft-deletes a phone-book contact. | admin | yes |
| `contacts.get` | `GET /api/v1/contacts/{id}` | Reads one live contact by id. | user | no |
| `contacts.list` | `GET /api/v1/contacts` | Lists the tenant's live phone-book contacts. | user | no |
| `contacts.update` | `PATCH /api/v1/contacts/{id}` | Updates a contact's details; `phones` replaces the number set as a whole. | admin | no |
| `devices.create` | `POST /api/v1/users/{id}/devices` | Creates a SIP device for a user; a manual device's connection settings are returned once. | user | no |
| `devices.delete` | `DELETE /api/v1/devices/{id}` | Soft-deletes a device. | user | yes |
| `devices.getBlf` | `GET /api/v1/devices/{id}/blf` | Reads a ringotel device's BLF panel. | user | no |
| `devices.list` | `GET /api/v1/users/{id}/devices` | Lists a user's live devices, paginated. | user | no |
| `devices.revealCredentials` | `GET /api/v1/devices/{id}/credentials` | Reveals a device's SIP credentials; a manual device's as its full connection settings. | admin | no |
| `devices.rotate` | `POST /api/v1/devices/{id}/rotate` | Rotates a device's SIP password. | admin | yes |
| `devices.setBlf` | `PUT /api/v1/devices/{id}/blf` | Replaces a ringotel device's BLF panel as a whole. | user | no |
| `devices.update` | `PATCH /api/v1/devices/{id}` | Updates a device's label or, for a plain device, its IP allowlist. | user | no |
| `didBlocks.create` | `POST /api/v1/didBlocks` | Adds a number block: a base and a fixed digit count, or open-ended; groups DIDs and gives unassigned numbers in it a fallback (zamfono.help numbers) | admin | no |
| `didBlocks.delete` | `DELETE /api/v1/didBlocks/{id}` | Soft-deletes a number block once no live DID falls within it | admin | yes |
| `didBlocks.list` | `GET /api/v1/didBlocks` | Lists the tenant's number blocks with their digit counts and fallback targets | admin | no |
| `didBlocks.update` | `PATCH /api/v1/didBlocks/{id}` | Changes a number block's label, digit count or fallback target; the base is immutable | admin | no |
| `dids.create` | `POST /api/v1/dids` | Adds a DID, a phone number the tenant owns, and the forward target its calls go to (zamfono.help numbers) | admin | no |
| `dids.delete` | `DELETE /api/v1/dids/{id}` | Soft-deletes a DID unless it is the main number or presented as caller ID | admin | yes |
| `dids.list` | `GET /api/v1/dids` | Lists the tenant's DIDs | admin | no |
| `dids.update` | `PATCH /api/v1/dids/{id}` | Changes a DID's forward target; number and label are fixed at creation | admin | no |
| `hours.delete` | `DELETE /api/v1/users/{id}/hours`, `DELETE /api/v1/ringGroups/{id}/hours`, `DELETE /api/v1/menus/{id}/hours`, `DELETE /api/v1/tenant/hours` | Removes a scope's opening-hours schedule | user | yes |
| `hours.get` | `GET /api/v1/users/{id}/hours`, `GET /api/v1/ringGroups/{id}/hours`, `GET /api/v1/menus/{id}/hours`, `GET /api/v1/tenant/hours` | Reads a scope's opening-hours schedule | user | no |
| `hours.set` | `PUT /api/v1/users/{id}/hours`, `PUT /api/v1/ringGroups/{id}/hours`, `PUT /api/v1/menus/{id}/hours`, `PUT /api/v1/tenant/hours` | Replaces a scope's weekly opening-hours schedule and the target its calls go to while closed | user | no |
| `mailTemplates.delete` | `DELETE /api/v1/mailTemplates/{kind}/{language}` | Removes a tenant's mail template override, so the shipped template applies again | admin | yes |
| `mailTemplates.get` | `GET /api/v1/mailTemplates/{kind}/{language}` | Reads the effective mail template of a kind and language: the tenant override, else the shipped one | admin | no |
| `mailTemplates.list` | `GET /api/v1/mailTemplates` | Lists the effective mail templates in the tenant language | admin | no |
| `mailTemplates.put` | `PUT /api/v1/mailTemplates/{kind}/{language}` | Overrides the shipped mail template of a kind and language, checked against the kind's placeholders | admin | no |
| `mailTemplates.test` | `POST /api/v1/mailTemplates/{kind}/test` | Sends a mail template to the caller with sample values | admin | no |
| `menus.create` | `POST /api/v1/menus` | Creates an auto-attendant menu: a greeting, a DTMF-to-target map (menus.setTargets) and a fallback. | admin | no |
| `menus.delete` | `DELETE /api/v1/menus/{id}` | Soft-deletes a menu. | admin | yes |
| `menus.get` | `GET /api/v1/menus/{id}` | Reads one live menu by id. | admin | no |
| `menus.getTargets` | `GET /api/v1/menus/{id}/targets` | Reads a menu's DTMF-to-target map. | admin | no |
| `menus.list` | `GET /api/v1/menus` | Lists the tenant's live menus. | admin | no |
| `menus.setTargets` | `PUT /api/v1/menus/{id}/targets` | Replaces a menu's DTMF-to-target map as a whole. | admin | no |
| `menus.update` | `PATCH /api/v1/menus/{id}` | Updates a menu's configuration. | admin | no |
| `ooo.create` | `POST /api/v1/users/{id}/ooo`, `POST /api/v1/ringGroups/{id}/ooo`, `POST /api/v1/menus/{id}/ooo`, `POST /api/v1/tenant/ooo` | Adds an out-of-office rule to a scope: while in effect, its calls go to the rule's target, ahead of opening hours | user | no |
| `ooo.delete` | `DELETE /api/v1/ooo/{id}` | Removes an out-of-office rule | user | yes |
| `ooo.list` | `GET /api/v1/users/{id}/ooo`, `GET /api/v1/ringGroups/{id}/ooo`, `GET /api/v1/menus/{id}/ooo`, `GET /api/v1/tenant/ooo` | Lists a scope's out-of-office rules | user | no |
| `ooo.update` | `PATCH /api/v1/ooo/{id}` | Changes an out-of-office rule's activity, start, expiry or target | user | no |
| `outboundRoutes.list` | `GET /api/v1/outboundRoutes` | Lists outbound routes in evaluation order, each with its callers and numbers. | admin | no |
| `outboundRoutes.replace` | `PUT /api/v1/outboundRoutes` | Replaces the outbound route list as a whole, in evaluation order: a call takes the first route whose callers and numbers both match, falling through to the next when its trunk fails. | admin | no |
| `parking.get` | `GET /api/v1/parking/slots` | Reads the set of parking-slot extensions | admin | no |
| `parking.list` | `GET /api/v1/parking/calls` | Lists the calls parked right now: slot, call, caller (null when withheld), parked since and by whom. | user | no |
| `parking.set` | `PUT /api/v1/parking/slots` | Replaces the set of parking-slot extensions as a whole; an extension a user or ring group owns, or an emergency number, is refused | admin | no |
| `personalAccessTokens.create` | `POST /api/v1/users/{id}/personalAccessTokens` | Creates a personal access token, acting as the user, for a server application; its value is returned once. | user | no |
| `personalAccessTokens.list` | `GET /api/v1/users/{id}/personalAccessTokens` | Lists a user's personal access tokens, revoked and expired ones until the daily purge, paginated. | user | no |
| `personalAccessTokens.revoke` | `POST /api/v1/personalAccessTokens/{id}/revoke` | Revokes a personal access token; the application using it loses access at once. | user | yes |
| `presenceLog.snapshot` | `GET /api/v1/presence/log` | Snapshots each user's presence state as of a past timestamp. | admin | no |
| `provisioning.ringotelAdopt` | `POST /api/v1/provisioning/ringotel/adopt` | Adopts an existing, empty Ringotel organization (by id and domain) and one of its connections, or a new one, instead of creating them. | owner | yes |
| `provisioning.ringotelOptions` | `GET /api/v1/provisioning/ringotel/options` | Lists the Ringotel regions and packages the account offers, the choices provisioning.ringotelSetup takes. | owner | no |
| `provisioning.ringotelSetup` | `POST /api/v1/provisioning/ringotel/setup` | Creates the Ringotel organization and connection, and stores their ids; provisioning.ringotelOptions lists the regions and packages it takes. | owner | no |
| `recordings.audio` | `GET /api/v1/recordings/{id}/audio` | Returns a recording's mixed audio; over MCP, a download link that opens for five minutes. | admin | no |
| `recordings.delete` | `DELETE /api/v1/recordings/{id}` | Permanently deletes a call recording and its audio file. | admin | yes |
| `recordings.list` | `GET /api/v1/recordings` | Lists call recordings, newest first: one per recorded user and call (see zamfono.help recording-consent). | admin | no |
| `ringGroups.create` | `POST /api/v1/ringGroups` | Creates a ring group and assigns it a tenant extension. | admin | no |
| `ringGroups.delete` | `DELETE /api/v1/ringGroups/{id}` | Soft-deletes a ring group. | admin | yes |
| `ringGroups.get` | `GET /api/v1/ringGroups/{id}` | Reads one live ring group by id. | admin | no |
| `ringGroups.getForwarding` | `GET /api/v1/ringGroups/{id}/forwarding` | Reads a ring group's 'unanswered' and 'unavailable' forwarding rules in the shape ringGroups.setForwarding takes. | admin | no |
| `ringGroups.list` | `GET /api/v1/ringGroups` | Lists the tenant's live ring groups. | admin | no |
| `ringGroups.setForwarding` | `PUT /api/v1/ringGroups/{id}/forwarding` | Replaces a ring group's 'unanswered' and 'unavailable' forwarding rules as a whole. | admin | no |
| `ringGroups.update` | `PATCH /api/v1/ringGroups/{id}` | Updates a ring group's configuration. | admin | no |
| `search.query` | `GET /api/v1/search` | The type-ahead behind the search bar: users, ring groups and contacts. | user | no |
| `settings.get` | `GET /api/v1/settings` | Reads the tenant settings row, each secret only as whether it is set | admin | no |
| `settings.update` | `PATCH /api/v1/settings` | Updates tenant-wide settings: main number, fallback, country, language, mail relay, feature codes, retention, SSO and more; owner-only fields say so | admin | no |
| `sipAllowlist.create` | `POST /api/v1/sipAllowlist` | Exempts a source address or range from SIP bans, ending every active ban it covers | admin | no |
| `sipAllowlist.delete` | `DELETE /api/v1/sipAllowlist/{id}` | Removes a source from the SIP ban allowlist | admin | yes |
| `sipAllowlist.list` | `GET /api/v1/sipAllowlist` | Lists the source addresses and ranges never banned for failed SIP attempts | admin | no |
| `sipBans.lift` | `DELETE /api/v1/sipBans/{id}` | Ends an active SIP ban now, a permanent one included; the ban stays listed as ended | admin | yes |
| `sipBans.list` | `GET /api/v1/sipBans` | Lists the bans of sources of failed SIP attempts, the active ones unless state says otherwise | admin | no |
| `stats.query` | `GET /api/v1/stats` | Buckets a call metric (answerRate, ringToAnswer, avgCallLength, callVolume) over a time range. | admin | no |
| `system.checkUpdate` | `POST /api/v1/system/updateCheck` | Has the updater ask GitHub for the latest release now, at most once a minute (else it answers from its cache), and reads the update block system.info carries; a spent GitHub rate limit answers 503 with retryAfterS. | admin | no |
| `system.info` | `GET /api/v1/system/info` | Reads the version, commit and start time of api and core separately, when Asterisk started, the latest release and last update with who asked for it, whether automatic updates are on and why and how often the last one failed, when and why the maintenance gate last gave up, whether a tenant profile or roster change still waits for Ringotel, how the last check or send of the mail relay went, which rows the latest config render left out, and the domain of the stack and the public IPv4 address its SIP and media use. | user | no |
| `system.update` | `POST /api/v1/system/update` | Updates the stack to the latest release, or to version, if newer and non-breaking; needs a backup run finished ok within the last hour. system.info reports the progress. | owner | yes |
| `trunks.create` | `POST /api/v1/trunks` | Creates a SIP trunk to a PSTN or SIP provider with its ordered host list; the first trunk also gets the catch-all outbound route. | admin | no |
| `trunks.delete` | `DELETE /api/v1/trunks/{id}` | Soft-deletes a SIP trunk once no outbound route or sip forward target uses it (409 names them). | admin | yes |
| `trunks.get` | `GET /api/v1/trunks/{id}` | Reads one SIP trunk. | admin | no |
| `trunks.list` | `GET /api/v1/trunks` | Lists SIP trunks in trunk order, with their live status merged in. | admin | no |
| `trunks.reregister` | `POST /api/v1/trunks/{id}/reregister` | Has a registration trunk unregister and register afresh with its provider; trunks.get's status and registeredAt show the outcome. Refused for an ip trunk. | admin | no |
| `trunks.setOrder` | `PUT /api/v1/trunks/order` | Rewrites the tenant trunk order, the order emergency calls try emergency trunks in (§9.4 "Trunk order"). | admin | no |
| `trunks.update` | `PATCH /api/v1/trunks/{id}` | Updates a SIP trunk; hosts replace the list as a whole, password is write-only. | admin | no |
| `userGroups.create` | `POST /api/v1/userGroups` | Creates a user group, a nestable set of users for ring-group membership and outbound-route caller lists. | admin | no |
| `userGroups.delete` | `DELETE /api/v1/userGroups/{id}` | Soft-deletes a user group. | admin | yes |
| `userGroups.get` | `GET /api/v1/userGroups/{id}` | Reads one live user group by id. | admin | no |
| `userGroups.list` | `GET /api/v1/userGroups` | Lists the tenant's live user groups. | admin | no |
| `userGroups.update` | `PATCH /api/v1/userGroups/{id}` | Updates a user group's name and nested membership. | admin | no |
| `users.clearVoicemailGreeting` | `DELETE /api/v1/users/{id}/voicemailGreeting` | Removes a user's personal voicemail greeting; callers hear the default prompt in the tenant language again. | user | yes |
| `users.create` | `POST /api/v1/users` | Creates a user, assigns their extension and returns a setup link. | admin | no |
| `users.delete` | `DELETE /api/v1/users/{id}` | Soft-deletes a user, cascading their devices, extension and sessions. | admin | yes |
| `users.erase` | `POST /api/v1/users/{id}/erase` | Erases a user's personal data from their audit trail (GDPR, irreversible). | owner | yes |
| `users.get` | `GET /api/v1/users/{id}` | Reads one live user by id. | user | no |
| `users.getForwarding` | `GET /api/v1/users/{id}/forwarding` | Reads a user's call-forwarding rules in the shape users.setForwarding takes; a user reads their own, an admin anyone's. | user | no |
| `users.list` | `GET /api/v1/users` | Lists the tenant's live users, paginated. | admin | no |
| `users.resetPassword` | `POST /api/v1/users/{id}/resetPassword` | Issues a new one-time link to set a user's password. | admin | no |
| `users.setForwarding` | `PUT /api/v1/users/{id}/forwarding` | Replaces a user's call-forwarding rules as a whole; a user sets their own, without new sip or recording targets, an admin anyone's. | user | no |
| `users.setPresence` | `PUT /api/v1/users/{id}/presence` | Sets a user's do-not-disturb state. | user | no |
| `users.setVoicemailGreeting` | `PUT /api/v1/users/{id}/voicemailGreeting` | Sets a user's personal voicemail greeting from a WAV or MP3 upload, as recording it on *96 does; over MCP, answers with a link to upload the file to. | user | no |
| `users.update` | `PATCH /api/v1/users/{id}` | Updates a user's profile; admins write every field, a user only their self-service subset. | user | no |
| `voicemails.audio` | `GET /api/v1/voicemails/{id}/audio` | Returns a voicemail's recorded audio; over MCP, a download link that opens for five minutes. | user | no |
| `voicemails.delete` | `DELETE /api/v1/voicemails/{id}` | Permanently deletes a voicemail and its audio file. | user | yes |
| `voicemails.list` | `GET /api/v1/voicemails` | Lists voicemails newest first: a user's own mailbox and their ring groups', every mailbox for an admin. | user | no |
| `voicemails.markRead` | `PATCH /api/v1/voicemails/{id}` | Marks a voicemail read or unread. | user | no |
| `webhooks.create` | `POST /api/v1/webhooks` | Adds a webhook, an endpoint every event (or the filtered types) is POSTed to; created inactive until switched on with webhooks.update | admin | no |
| `webhooks.delete` | `DELETE /api/v1/webhooks/{id}` | Soft-deletes a webhook; its events are no longer delivered | admin | yes |
| `webhooks.list` | `GET /api/v1/webhooks` | Lists the tenant's webhooks with their delivery status, ok or failing | admin | no |
| `webhooks.update` | `PATCH /api/v1/webhooks/{id}` | Changes a webhook's URL, secret or event-type filter, or switches it on or off | admin | no |
