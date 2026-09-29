| Operation | Description | Min role | Confirm |
| --- | --- | --- | --- |
| `audio.create` | Uploads and transcodes a new audio asset. | admin | no |
| `audio.delete` | Soft-deletes an audio asset. | admin | yes |
| `audio.list` | Lists the tenant's live audio assets. | admin | no |
| `audio.update` | Updates an audio asset's label. | admin | no |
| `audit.list` | Lists audit_log entries, filterable by entity, actor, channel, client, operation, time range and state. | admin | no |
| `audit.undo` | Reverts one audit entry by replaying its recorded 'from' values. | admin | no |
| `backups.runs.get` | Reads one backup run | admin | no |
| `backups.runs.list` | Lists backup runs, newest first | admin | no |
| `backups.runs.start` | Starts a backup run | admin | no |
| `backups.targets.create` | Adds a backup target | admin | no |
| `backups.targets.delete` | Removes a backup target | admin | yes |
| `backups.targets.list` | Lists the tenant's backup targets | admin | no |
| `backups.targets.update` | Changes a backup target | admin | no |
| `blockedNumbers.create` | Adds a number or number prefix to the tenant blocklist | admin | no |
| `blockedNumbers.delete` | Removes a number from the tenant blocklist | admin | yes |
| `blockedNumbers.list` | Lists the tenant's inbound blocklist | admin | no |
| `calls.get` | Reads one call of the history with its log and QoS summary. | user | no |
| `calls.hangup` | Hangs up a live call. | user | no |
| `calls.list` | Lists call history, or the calls currently in progress. | user | no |
| `calls.originate` | Click-to-dial: rings a user's devices, then dials the target on answer. | user | no |
| `calls.pickup` | Picks up a call ringing for another party. | user | no |
| `calls.transfer` | Blind-transfers a live call to another target. | user | no |
| `contacts.create` | Adds a phone-book contact. | admin | no |
| `contacts.delete` | Soft-deletes a phone-book contact. | admin | yes |
| `contacts.get` | Reads one live contact by id. | user | no |
| `contacts.list` | Lists the tenant's live phone-book contacts. | user | no |
| `contacts.update` | Updates a contact's details; `phones` replaces the number set as a whole. | admin | no |
| `devices.create` | Creates a SIP device for a user; a manual device's credentials are returned once. | user | no |
| `devices.delete` | Soft-deletes a device. | user | yes |
| `devices.getBlf` | Reads a ringotel device's BLF panel. | user | no |
| `devices.list` | Lists a user's live devices, paginated. | user | no |
| `devices.revealCredentials` | Reveals a device's SIP credentials. | admin | no |
| `devices.rotate` | Rotates a device's SIP password. | admin | yes |
| `devices.setBlf` | Replaces a ringotel device's BLF panel as a whole. | user | no |
| `devices.update` | Updates a device's label or, for a plain device, its IP allowlist. | user | no |
| `didBlocks.create` | Adds a number block | admin | no |
| `didBlocks.delete` | Soft-deletes a number block | admin | yes |
| `didBlocks.list` | Lists the tenant's number blocks | admin | no |
| `didBlocks.update` | Changes a number block's label, digit count or fallback target | admin | no |
| `dids.create` | Adds a DID and its forward target | admin | no |
| `dids.delete` | Soft-deletes a DID | admin | yes |
| `dids.list` | Lists the tenant's DIDs | admin | no |
| `dids.update` | Changes a DID's forward target | admin | no |
| `hours.delete` | Removes a scope's opening-hours schedule | user | yes |
| `hours.get` | Reads a scope's opening-hours schedule | user | no |
| `hours.set` | Replaces a scope's opening-hours schedule | user | no |
| `mailTemplates.delete` | Removes a tenant's mail template override | admin | yes |
| `mailTemplates.get` | Reads one mail template | admin | no |
| `mailTemplates.list` | Lists the effective mail templates in the tenant language | admin | no |
| `mailTemplates.put` | Sets a tenant's mail template override | admin | no |
| `mailTemplates.test` | Sends a mail template to the caller with sample values | admin | no |
| `menus.create` | Creates an auto-attendant menu. | admin | no |
| `menus.delete` | Soft-deletes a menu. | admin | yes |
| `menus.get` | Reads one live menu by id. | admin | no |
| `menus.getTargets` | Reads a menu's DTMF-to-target map. | admin | no |
| `menus.list` | Lists the tenant's live menus. | admin | no |
| `menus.setTargets` | Replaces a menu's DTMF-to-target map as a whole. | admin | no |
| `menus.update` | Updates a menu's configuration. | admin | no |
| `ooo.create` | Adds an out-of-office rule to a scope | user | no |
| `ooo.delete` | Removes an out-of-office rule | user | yes |
| `ooo.list` | Lists a scope's out-of-office rules | user | no |
| `ooo.update` | Changes an out-of-office rule | user | no |
| `outboundRoutes.list` | Lists outbound routes in evaluation order, each with its callers and numbers. | admin | no |
| `outboundRoutes.replace` | Replaces the outbound route list as a whole, in evaluation order. | admin | no |
| `parking.get` | Reads the set of parking-slot extensions | admin | no |
| `parking.set` | Replaces the set of parking-slot extensions | admin | no |
| `presenceLog.snapshot` | Snapshots each user's presence state as of a past timestamp. | admin | no |
| `provisioning.ringotelAdopt` | Adopts an existing, empty Ringotel organization (by id and domain) and one of its connections, or a new one, instead of creating them. | owner | yes |
| `provisioning.ringotelOptions` | Lists the Ringotel regions and packages the account offers, the choices provisioning.ringotelSetup takes. | owner | no |
| `provisioning.ringotelSetup` | Creates the Ringotel organization and connection, and stores their ids; provisioning.ringotelOptions lists the regions and packages it takes. | owner | no |
| `recordings.audio` | Returns a recording's mixed audio. | admin | no |
| `recordings.delete` | Permanently deletes a call recording and its audio file. | admin | yes |
| `recordings.list` | Lists call recordings. | admin | no |
| `ringGroups.create` | Creates a ring group and assigns it a tenant extension. | admin | no |
| `ringGroups.delete` | Soft-deletes a ring group. | admin | yes |
| `ringGroups.get` | Reads one live ring group by id. | admin | no |
| `ringGroups.list` | Lists the tenant's live ring groups. | admin | no |
| `ringGroups.setForwarding` | Replaces a ring group's 'unanswered' and 'unavailable' forwarding rules as a whole. | admin | no |
| `ringGroups.update` | Updates a ring group's configuration. | admin | no |
| `search.query` | The type-ahead behind the search bar: users, ring groups and contacts. | user | no |
| `settings.get` | Reads the tenant settings row, with secrets masked | admin | no |
| `settings.update` | Updates the tenant settings row | admin | no |
| `stats.query` | Buckets a call metric (answerRate, ringToAnswer, avgCallLength, callVolume) over a time range. | admin | no |
| `system.info` | Reads the version and commit the stack runs, for api and core separately. | user | no |
| `trunks.create` | Creates a SIP trunk and its ordered host list. | admin | no |
| `trunks.delete` | Soft-deletes a SIP trunk. | admin | yes |
| `trunks.get` | Reads one SIP trunk. | admin | no |
| `trunks.list` | Lists SIP trunks in trunk order, with their live status merged in. | admin | no |
| `trunks.setOrder` | Rewrites the tenant trunk order (§9.4 "Trunk order"). | admin | no |
| `trunks.update` | Updates a SIP trunk; password is write-only. | admin | no |
| `userGroups.create` | Creates a user group. | admin | no |
| `userGroups.delete` | Soft-deletes a user group. | admin | yes |
| `userGroups.get` | Reads one live user group by id. | admin | no |
| `userGroups.list` | Lists the tenant's live user groups. | admin | no |
| `userGroups.update` | Updates a user group's name and nested membership. | admin | no |
| `users.create` | Creates a user, assigns their extension and returns a setup link. | admin | no |
| `users.delete` | Soft-deletes a user, cascading their devices, extension and sessions. | admin | yes |
| `users.erase` | Erases a user's personal data from their audit trail (GDPR, irreversible). | owner | yes |
| `users.get` | Reads one live user by id. | user | no |
| `users.list` | Lists the tenant's live users, paginated. | admin | no |
| `users.resetPassword` | Issues a new one-time link to set a user's password. | admin | no |
| `users.setForwarding` | Replaces a user's call-forwarding rules as a whole. | admin | no |
| `users.setPresence` | Sets a user's do-not-disturb state. | user | no |
| `users.update` | Updates a user's profile; admins write every field, a user only their self-service subset. | user | no |
| `voicemails.audio` | Returns a voicemail's recorded audio. | user | no |
| `voicemails.delete` | Permanently deletes a voicemail and its audio file. | user | yes |
| `voicemails.list` | Lists voicemails in the caller's own mailbox scope. | user | no |
| `voicemails.markRead` | Marks a voicemail read or unread. | user | no |
| `webhooks.create` | Adds a webhook, created inactive | admin | no |
| `webhooks.delete` | Removes a webhook | admin | yes |
| `webhooks.list` | Lists the tenant's webhooks | admin | no |
| `webhooks.update` | Changes a webhook | admin | no |
