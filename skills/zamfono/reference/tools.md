| Operation (MCP tool) | REST | Description | Min role | Confirm |
| --- | --- | --- | --- | --- |
| `audio.create` | `POST /audio` | Uploads and transcodes a new audio asset. | admin | no |
| `audio.delete` | `DELETE /audio/{id}` | Soft-deletes an audio asset. | admin | yes |
| `audio.list` | `GET /audio` | Lists the tenant's live audio assets. | admin | no |
| `audio.update` | `PATCH /audio/{id}` | Updates an audio asset's label. | admin | no |
| `audit.list` | `GET /audit` | Lists audit_log entries, filterable by entity, actor, channel, client, operation, time range and state. | admin | no |
| `audit.undo` | `POST /audit/{id}/undo` | Reverts one audit entry by replaying its recorded 'from' values. | admin | no |
| `backups.runs.get` | `GET /backups/runs/{id}` | Reads one backup run | admin | no |
| `backups.runs.list` | `GET /backups/runs` | Lists backup runs, newest first | admin | no |
| `backups.runs.start` | `POST /backups/runs` | Starts a backup run | admin | no |
| `backups.targets.create` | `POST /backups/targets` | Adds a backup target | admin | no |
| `backups.targets.delete` | `DELETE /backups/targets/{id}` | Removes a backup target | admin | yes |
| `backups.targets.list` | `GET /backups/targets` | Lists the tenant's backup targets | admin | no |
| `backups.targets.update` | `PATCH /backups/targets/{id}` | Changes a backup target | admin | no |
| `blockedNumbers.create` | `POST /blockedNumbers` | Adds a number or number prefix to the tenant blocklist | admin | no |
| `blockedNumbers.delete` | `DELETE /blockedNumbers/{id}` | Removes a number from the tenant blocklist | admin | yes |
| `blockedNumbers.list` | `GET /blockedNumbers` | Lists the tenant's inbound blocklist | admin | no |
| `calls.get` | `GET /calls/{id}` | Reads one call of the history with its log and QoS summary: per leg jitter, loss, round trip and the packets received and sent. | user | no |
| `calls.hangup` | `POST /calls/{id}/hangup` | Hangs up a live call. | user | no |
| `calls.list` | `GET /calls` | Lists call history, or the calls currently in progress. | user | no |
| `calls.originate` | `POST /calls` | Click-to-dial: rings a user's devices, then dials the target on answer. | user | no |
| `calls.pickup` | `POST /calls/{id}/pickup` | Picks up a call ringing for another party. | user | no |
| `calls.transfer` | `POST /calls/{id}/transfer` | Blind-transfers a live call to another target. | user | no |
| `contacts.create` | `POST /contacts` | Adds a phone-book contact. | admin | no |
| `contacts.delete` | `DELETE /contacts/{id}` | Soft-deletes a phone-book contact. | admin | yes |
| `contacts.get` | `GET /contacts/{id}` | Reads one live contact by id. | user | no |
| `contacts.list` | `GET /contacts` | Lists the tenant's live phone-book contacts. | user | no |
| `contacts.update` | `PATCH /contacts/{id}` | Updates a contact's details; `phones` replaces the number set as a whole. | admin | no |
| `devices.create` | `POST /users/{id}/devices` | Creates a SIP device for a user; a manual device's credentials are returned once. | user | no |
| `devices.delete` | `DELETE /devices/{id}` | Soft-deletes a device. | user | yes |
| `devices.getBlf` | `GET /devices/{id}/blf` | Reads a ringotel device's BLF panel. | user | no |
| `devices.list` | `GET /users/{id}/devices` | Lists a user's live devices, paginated. | user | no |
| `devices.revealCredentials` | `GET /devices/{id}/credentials` | Reveals a device's SIP credentials. | admin | no |
| `devices.rotate` | `POST /devices/{id}/rotate` | Rotates a device's SIP password. | admin | yes |
| `devices.setBlf` | `PUT /devices/{id}/blf` | Replaces a ringotel device's BLF panel as a whole. | user | no |
| `devices.update` | `PATCH /devices/{id}` | Updates a device's label or, for a plain device, its IP allowlist. | user | no |
| `didBlocks.create` | `POST /didBlocks` | Adds a number block | admin | no |
| `didBlocks.delete` | `DELETE /didBlocks/{id}` | Soft-deletes a number block | admin | yes |
| `didBlocks.list` | `GET /didBlocks` | Lists the tenant's number blocks | admin | no |
| `didBlocks.update` | `PATCH /didBlocks/{id}` | Changes a number block's label, digit count or fallback target | admin | no |
| `dids.create` | `POST /dids` | Adds a DID and its forward target | admin | no |
| `dids.delete` | `DELETE /dids/{id}` | Soft-deletes a DID | admin | yes |
| `dids.list` | `GET /dids` | Lists the tenant's DIDs | admin | no |
| `dids.update` | `PATCH /dids/{id}` | Changes a DID's forward target | admin | no |
| `hours.delete` | `DELETE /users/{id}/hours`, `DELETE /ringGroups/{id}/hours`, `DELETE /menus/{id}/hours`, `DELETE /tenant/hours` | Removes a scope's opening-hours schedule | user | yes |
| `hours.get` | `GET /users/{id}/hours`, `GET /ringGroups/{id}/hours`, `GET /menus/{id}/hours`, `GET /tenant/hours` | Reads a scope's opening-hours schedule | user | no |
| `hours.set` | `PUT /users/{id}/hours`, `PUT /ringGroups/{id}/hours`, `PUT /menus/{id}/hours`, `PUT /tenant/hours` | Replaces a scope's opening-hours schedule | user | no |
| `mailTemplates.delete` | `DELETE /mailTemplates/{kind}/{language}` | Removes a tenant's mail template override | admin | yes |
| `mailTemplates.get` | `GET /mailTemplates/{kind}/{language}` | Reads one mail template | admin | no |
| `mailTemplates.list` | `GET /mailTemplates` | Lists the effective mail templates in the tenant language | admin | no |
| `mailTemplates.put` | `PUT /mailTemplates/{kind}/{language}` | Sets a tenant's mail template override | admin | no |
| `mailTemplates.test` | `POST /mailTemplates/{kind}/test` | Sends a mail template to the caller with sample values | admin | no |
| `menus.create` | `POST /menus` | Creates an auto-attendant menu. | admin | no |
| `menus.delete` | `DELETE /menus/{id}` | Soft-deletes a menu. | admin | yes |
| `menus.get` | `GET /menus/{id}` | Reads one live menu by id. | admin | no |
| `menus.getTargets` | `GET /menus/{id}/targets` | Reads a menu's DTMF-to-target map. | admin | no |
| `menus.list` | `GET /menus` | Lists the tenant's live menus. | admin | no |
| `menus.setTargets` | `PUT /menus/{id}/targets` | Replaces a menu's DTMF-to-target map as a whole. | admin | no |
| `menus.update` | `PATCH /menus/{id}` | Updates a menu's configuration. | admin | no |
| `ooo.create` | `POST /users/{id}/ooo`, `POST /ringGroups/{id}/ooo`, `POST /menus/{id}/ooo`, `POST /tenant/ooo` | Adds an out-of-office rule to a scope | user | no |
| `ooo.delete` | `DELETE /ooo/{id}` | Removes an out-of-office rule | user | yes |
| `ooo.list` | `GET /users/{id}/ooo`, `GET /ringGroups/{id}/ooo`, `GET /menus/{id}/ooo`, `GET /tenant/ooo` | Lists a scope's out-of-office rules | user | no |
| `ooo.update` | `PATCH /ooo/{id}` | Changes an out-of-office rule | user | no |
| `outboundRoutes.list` | `GET /outboundRoutes` | Lists outbound routes in evaluation order, each with its callers and numbers. | admin | no |
| `outboundRoutes.replace` | `PUT /outboundRoutes` | Replaces the outbound route list as a whole, in evaluation order. | admin | no |
| `parking.get` | `GET /parking/slots` | Reads the set of parking-slot extensions | admin | no |
| `parking.set` | `PUT /parking/slots` | Replaces the set of parking-slot extensions | admin | no |
| `presenceLog.snapshot` | `GET /presence/log` | Snapshots each user's presence state as of a past timestamp. | admin | no |
| `provisioning.ringotelAdopt` | `POST /provisioning/ringotel/adopt` | Adopts an existing, empty Ringotel organization (by id and domain) and one of its connections, or a new one, instead of creating them. | owner | yes |
| `provisioning.ringotelOptions` | `GET /provisioning/ringotel/options` | Lists the Ringotel regions and packages the account offers, the choices provisioning.ringotelSetup takes. | owner | no |
| `provisioning.ringotelSetup` | `POST /provisioning/ringotel/setup` | Creates the Ringotel organization and connection, and stores their ids; provisioning.ringotelOptions lists the regions and packages it takes. | owner | no |
| `recordings.audio` | `GET /recordings/{id}/audio` | Returns a recording's mixed audio. | admin | no |
| `recordings.delete` | `DELETE /recordings/{id}` | Permanently deletes a call recording and its audio file. | admin | yes |
| `recordings.list` | `GET /recordings` | Lists call recordings. | admin | no |
| `ringGroups.create` | `POST /ringGroups` | Creates a ring group and assigns it a tenant extension. | admin | no |
| `ringGroups.delete` | `DELETE /ringGroups/{id}` | Soft-deletes a ring group. | admin | yes |
| `ringGroups.get` | `GET /ringGroups/{id}` | Reads one live ring group by id. | admin | no |
| `ringGroups.list` | `GET /ringGroups` | Lists the tenant's live ring groups. | admin | no |
| `ringGroups.setForwarding` | `PUT /ringGroups/{id}/forwarding` | Replaces a ring group's 'unanswered' and 'unavailable' forwarding rules as a whole. | admin | no |
| `ringGroups.update` | `PATCH /ringGroups/{id}` | Updates a ring group's configuration. | admin | no |
| `search.query` | `GET /search` | The type-ahead behind the search bar: users, ring groups and contacts. | user | no |
| `settings.get` | `GET /settings` | Reads the tenant settings row, with secrets masked | admin | no |
| `settings.update` | `PATCH /settings` | Updates the tenant settings row | admin | no |
| `stats.query` | `GET /stats` | Buckets a call metric (answerRate, ringToAnswer, avgCallLength, callVolume) over a time range. | admin | no |
| `system.info` | `GET /system/info` | Reads the version, commit and start time of api and core separately, when Asterisk started, the latest release and last update, whether a tenant profile change still waits for Ringotel, and the domain of the stack and the public IPv4 address its SIP and media use. | user | no |
| `system.update` | `POST /system/update` | Updates the stack to the latest release, or to version, if newer and non-breaking; needs a backup run finished ok within the last hour. system.info reports the progress. | owner | yes |
| `trunks.create` | `POST /trunks` | Creates a SIP trunk and its ordered host list. | admin | no |
| `trunks.delete` | `DELETE /trunks/{id}` | Soft-deletes a SIP trunk. | admin | yes |
| `trunks.get` | `GET /trunks/{id}` | Reads one SIP trunk. | admin | no |
| `trunks.list` | `GET /trunks` | Lists SIP trunks in trunk order, with their live status merged in. | admin | no |
| `trunks.setOrder` | `PUT /trunks/order` | Rewrites the tenant trunk order (§9.4 "Trunk order"). | admin | no |
| `trunks.update` | `PATCH /trunks/{id}` | Updates a SIP trunk; password is write-only. | admin | no |
| `userGroups.create` | `POST /userGroups` | Creates a user group. | admin | no |
| `userGroups.delete` | `DELETE /userGroups/{id}` | Soft-deletes a user group. | admin | yes |
| `userGroups.get` | `GET /userGroups/{id}` | Reads one live user group by id. | admin | no |
| `userGroups.list` | `GET /userGroups` | Lists the tenant's live user groups. | admin | no |
| `userGroups.update` | `PATCH /userGroups/{id}` | Updates a user group's name and nested membership. | admin | no |
| `users.create` | `POST /users` | Creates a user, assigns their extension and returns a setup link. | admin | no |
| `users.delete` | `DELETE /users/{id}` | Soft-deletes a user, cascading their devices, extension and sessions. | admin | yes |
| `users.erase` | `POST /users/{id}/erase` | Erases a user's personal data from their audit trail (GDPR, irreversible). | owner | yes |
| `users.get` | `GET /users/{id}` | Reads one live user by id. | user | no |
| `users.list` | `GET /users` | Lists the tenant's live users, paginated. | admin | no |
| `users.resetPassword` | `POST /users/{id}/resetPassword` | Issues a new one-time link to set a user's password. | admin | no |
| `users.setForwarding` | `PUT /users/{id}/forwarding` | Replaces a user's call-forwarding rules as a whole; a user sets their own, without sip targets, an admin anyone's. | user | no |
| `users.setPresence` | `PUT /users/{id}/presence` | Sets a user's do-not-disturb state. | user | no |
| `users.update` | `PATCH /users/{id}` | Updates a user's profile; admins write every field, a user only their self-service subset. | user | no |
| `voicemails.audio` | `GET /voicemails/{id}/audio` | Returns a voicemail's recorded audio. | user | no |
| `voicemails.delete` | `DELETE /voicemails/{id}` | Permanently deletes a voicemail and its audio file. | user | yes |
| `voicemails.list` | `GET /voicemails` | Lists voicemails in the caller's own mailbox scope. | user | no |
| `voicemails.markRead` | `PATCH /voicemails/{id}` | Marks a voicemail read or unread. | user | no |
| `webhooks.create` | `POST /webhooks` | Adds a webhook, created inactive | admin | no |
| `webhooks.delete` | `DELETE /webhooks/{id}` | Removes a webhook | admin | yes |
| `webhooks.list` | `GET /webhooks` | Lists the tenant's webhooks | admin | no |
| `webhooks.update` | `PATCH /webhooks/{id}` | Changes a webhook | admin | no |
