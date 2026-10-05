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
   all, usually a missing `UPDATER_TOKEN` or `CONTAINER_SOCKET` in `.env`. On a test stack whose
   `ZAMFONO_VERSION` is `edge`, `current` and `latest` both say `edge`, `latest` naming main's
   newest build; `updatable: true` means the stack runs an older one, and the update pulls it.
2. Back up first: `backups.runs.start` (`POST /backups/runs`) on a target from
   `backups.targets.list` (`GET /backups/targets`), then read the run with `backups.runs.get`
   (`GET /backups/runs/{id}`) until its `status` is `ok`. The update is refused without a backup
   finished `ok` within the last hour, since migrations only go forward and the backup is the way
   back.
3. Update: `system.update` (`POST /system/update`), optionally with `version`. It asks for
   confirmation and answers as soon as the updater has begun.
4. Follow it with `system.info`: `update.last.state` goes from `running` to `succeeded` or `failed`,
   with the end of the updater's log in `error`, and `update.last.trigger` says who asked:
   `manual` (with the owner in `by`), `automatic` or `host` (`update.sh` on the host).
   `succeeded` means every recreated service reported healthy, `core` included. While the stack restarts, calls drop and the API
   does not answer for a minute or two; `system.info` answering again with the new `api.version`
   is the sign it is done. Its `api.startedAt` and `core.startedAt` show the restart, and
   `core.asteriskStartedAt` when Asterisk came back; with Ringotel connected, the stack then tells
   Ringotel to re-register the apps (a `ringotel.rereg` entry in `audit.list`).

## Automatic updates

An owner can let the stack take newer non-breaking releases on its own: `settings.update`
(`PATCH /settings`) with `{ "autoUpdate": true }`; it is off by default. The stack then asks the
updater every hour. When a release is available, it waits for the next maintenance moment, the
same quiet time a renewed TLS certificate is swapped in at: the middle of a tenant-wide
out-of-office period, else of the longest closed period of the opening hours, else
`settings.tlsReloadHour`, else the hour `TLS_RELOAD_HOUR` in `.env` names, else 03:00. Then it waits until nothing is in progress (no call, no
parked call, no voicemail being left, no recording), looking again every 5 minutes for up to two
hours, after which it gives up and waits for the next maintenance moment: it logs a warning and
writes a `system.maintenanceGate` entry to the audit log with what kept the stack busy (the live
calls, Asterisk channels and recordings in progress), and `system.info` shows the last such give-up
in `maintenanceGate.autoUpdate` (`maintenanceGate.certSync` for the certificate). Once the moment
comes and the stack is idle, it backs up every enabled backup target and then updates exactly as
`system.update` does; without an enabled target there is no backup, and the update fails with
`no enabled backup target`.

A stack still busy when the gate gives up at 3 maintenance moments in a row counts that as a
failed attempt. A failed automatic update is tried again at a later maintenance moment, at least
20 hours after the failed attempt, so about once a day, up to 3 attempts per release; after the third failed
attempt the stack leaves that release alone until a newer one appears or an update succeeds. An
update that is already running when the stack asks, one started with `system.update` or
`update.sh`, counts as no failed attempt: the stack tries again once it ended. From the first
failure until an update succeeds:

- `/healthz` warns `update:automatic`, and `/metrics` (with `METRICS_TOKEN`)
  `zamfono_auto_update_failed 1` with the failed attempts in
  `zamfono_auto_update_failed_attempts`;
- `system.info` shows the release in `autoUpdate.failed`, with the reason of the last attempt,
  such as `no enabled backup target`, the target and error of a failed backup, the updater's
  refusal, the end of the updater's log or what kept the stack busy, and the failed `attempts` on
  that release;
- every owner gets one `updateFailed` mail once the last attempt failed (see `mail-templates`);
- `audit.list` has a `system.autoUpdate` entry on channel `job` for every attempt and outcome:
  `started`, `noBackupTarget`, `backupFailed`, `busy`, `refused`, `succeeded` or `failed`, a
  failure with the same `reason`.

Fix the cause, then update with `system.update` as above, or wait for the next release or the
next attempt. An update that installed the new release's files but whose stack did not report
healthy shows that release as `current`; `system.update`, or the next attempt, finishes it.

## Breaking releases

A breaking release (a new major from 1.0.0 on, a new minor before) is never installed by
`system.update` or automatically, whether `autoUpdate` is on or not. The stack announces it:
`system.info` shows the release in `update.latest` with `update.breaking: true`, `/metrics` has
`zamfono_breaking_update_available 1`, and every owner gets one `breakingUpdate` mail per such
release. `/healthz`, the public uptime check, says nothing of releases, since anyone can read it.
Without `UPDATER_TOKEN` the stack asks no updater, updates nothing on its own and announces
nothing: `/healthz` passes `update:automatic`, the `/metrics` update gauges are
0, and `system.info` has no `autoUpdate.failed`. Read its upgrade notes, then install it on the host with
`update.sh`.

## Undoing an update

The update cannot be undone through the audit log. Going back means restoring the backup (see
`restore`) and installing the previous release's bundle on the host.
