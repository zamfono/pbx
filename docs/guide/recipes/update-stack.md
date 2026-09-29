---
title: Update the stack
arguments:
  - name: version
    description: The release to install, X.Y.Z; the latest when omitted
    required: false
---

# Update the stack

The owner installs a newer release without a shell on the host. The stack's `updater` service does
the work; it takes only a published release that is newer than the running one and not breaking.

1. Check what is available: `system.info` (`GET /system/info`). Its `update` field names the
   `current` and the `latest` release. `updatable: true` means `system.update` can install it.
   `breaking: true` means the release needs the operator: it is installed on the host with
   `update.sh`, after reading its upgrade notes. `unavailable` says why the updater cannot run at
   all, usually a missing `UPDATER_TOKEN` or `CONTAINER_SOCKET` in `.env`.
2. Back up first: `backups.runs.start` (`POST /backups/runs`) on a target from
   `backups.targets.list` (`GET /backups/targets`), then read the run with `backups.runs.get`
   (`GET /backups/runs/{id}`) until its `status` is `ok`. The update is refused without a backup
   finished `ok` within the last hour, since migrations only go forward and the backup is the way
   back.
3. Update: `system.update` (`POST /system/update`), optionally with `version`. It asks for
   confirmation and answers as soon as the updater has begun.
4. Follow it with `system.info`: `update.last.state` goes from `running` to `succeeded` or `failed`,
   with the end of the updater's log in `error`. While the stack restarts, calls drop and the API
   does not answer for a minute or two; `system.info` answering again with the new `api.version`
   is the sign it is done.

The update cannot be undone through the audit log. Going back means restoring the backup (see
`restore`) and installing the previous release's bundle on the host.
