# Restore

Moving a stack to another host, or recovering it after data loss, is the same procedure: restore
`.env`, then the database, then the media volume, then start the stack.

## What a restore needs

- **`.env`**, preserved from the original host: it holds the secretbox encryption key, the JWT
  secret and the ARI password.
- **The restic repository location and password for each target**, from the operator's own record of
  what was entered in `backups.targets.create` (`POST /backups/targets`) when the target was
  created, or an out-of-band copy kept alongside `.env` — a target's encrypted repository password
  lives inside the database itself, so it is not available until after a restic-based restore has
  already produced that database.
- **The database**, from `litestream restore` (with the optional continuous-replication overlay
  running, using that overlay's own bucket credentials) or from the latest restic snapshot
  otherwise.
- **`media/`**, from the latest restic snapshot — voicemail and recording audio, uploaded
  greetings and hold-music files.

## Procedure

1. Provision the new host and copy the preserved `.env` onto it.
2. Restore the database: `litestream restore` for a recovery point within seconds, or otherwise a
   restic restore of the latest snapshot using the repository location and password from the
   operator's own record.
3. Restore `media/` from the latest restic snapshot, the same way.
4. `docker compose up -d` (or the Podman equivalent).

With continuous replication, configuration, users and call history are current to within
seconds, and media newer than the last restic run is lost. Without it, everything is as old as
the last restic snapshot.

## Conditions

- Pin the Litestream image version exactly. A change of its first non-zero version component
  (0.5 → 0.6 while it is 0.x, 1.x → 2.x from 1.0 on) can change the replica format, so it runs as
  a deliberate migration with a fresh snapshot taken right after; patch releases are ordinary
  updates.
- The replication bucket needs server-side encryption — the WAL stream itself is not
  client-side encrypted, unlike the restic repository.
- `backups.runs.list` (`GET /backups/runs`) and the `backup.finished`/`backup.failed` events show
  the age and status of the restic runs a restore would fall back to.
