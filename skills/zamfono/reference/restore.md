# Restore

Moving a stack to another host, or recovering it after data loss, is the same procedure: unpack
the release's files, restore `.env`, then the database and the media into their volumes, then
start the stack.

## What a restore needs

- **`.env`**, preserved from the original host: it holds the secretbox encryption key, the JWT
  secret and the ARI password.
- **The default `local` target** needs nothing beyond `.env`: its repository is `/backups/restic`
  on the `backups` volume and its password is `BACKUP_PASSWORD`. It lives on the same host as the
  stack, so it restores a broken database or a bad upgrade, but a lost host takes it along; that
  is what a target elsewhere is for.
- **The restic repository location and password for each other target**, from the operator's own record of
  what was entered in `backups.targets.create` (`POST /backups/targets`) when the target was
  created, or an out-of-band copy kept alongside `.env` — a target's encrypted repository password
  lives inside the database itself, so it is not available until after a restic-based restore has
  already produced that database.
- **The database**, from `litestream restore` (with the optional continuous-replication overlay,
  `compose.dr.yaml` in the stack directory, running, using that overlay's own bucket credentials)
  or from the latest restic snapshot otherwise.
- **`media/`**, from the latest restic snapshot — voicemail and recording audio, uploaded
  greetings and hold-music files.

## Procedure

The commands are Docker's; on Podman, `podman compose` takes the same arguments. On a host
where the stack still runs, stop it first and skip steps 1 to 3: `docker compose down`, which
keeps every volume, or `./setup/compose.sh down` with `compose.dr.yaml`; on Podman with the boot
unit of step 7, `systemctl stop zamfono.service`.

1. Provision the new host as `deploy/README.md` steps 1 to 4 describe, with the same mode, FQDN
   and public address.
2. Unpack the bundle of the release the stack ran (its `VERSION`), or of a newer one, whose
   migrations bring the restored database forward, into an empty stack directory, as step 5
   does: `releases/download/vX.Y.Z/zamfono-deploy.tar.gz` in place of `releases/latest/…`.
3. Copy the preserved `.env` into it, readable by root only (`chmod 600 .env`). Do not run
   `setup.sh`: it refuses a directory whose `.env` holds values, since it would generate new
   secrets. Make the link it would make instead: `ln -s compose.ports.yaml compose.override.yaml`
   when `.env` sets `EXTERNAL_IPV4`, `ln -s compose.macvlan.yaml compose.override.yaml` when it
   sets `STACK_IPV4`. With continuous replication, put the overlay back as `compose.dr.yaml`.
4. Restore the database and the media into the stack's volumes before the first start, with the
   restic and rclone of the `api` image, which runs as the uid the volumes belong to. A restic
   snapshot holds the database as `tmp/zamfono-backup/<targetId>/zamfono.sqlite3` and the media
   as `media/`. The database's `-wal` and `-shm` files go first: SQLite would otherwise replay
   the old write-ahead log onto the restored file.

   ```bash
   docker compose run --rm --no-deps --entrypoint sh \
     -e RESTIC_REPOSITORY='<repository>' -e RESTIC_PASSWORD='<password>' api -c '
       restic restore latest --target /tmp/restore &&
       rm -f /data/zamfono.sqlite3-wal /data/zamfono.sqlite3-shm &&
       cp /tmp/restore/tmp/zamfono-backup/*/zamfono.sqlite3 /data/zamfono.sqlite3 &&
       cp -a /tmp/restore/media/. /media/'
   ```

   The repository and the backend's variables (`-e NAME='<value>'` each) depend on the target's
   kind, with the values entered when it was created:

   | Kind          | Repository                        | Variables                                                                                         |
   | ------------- | --------------------------------- | ------------------------------------------------------------------------------------------------- |
   | `local`       | `/backups/restic`                 | none; the password is `BACKUP_PASSWORD` from `.env`                                               |
   | `s3`          | `s3:<endpoint>/<bucket>[/<path>]` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`                                                      |
   | `sftp`        | `sftp:<username>@<host>:<path>`   | `SSHPASS` (the password)                                                                          |
   | `ftp`, `ftps` | `rclone:zamfono:<path>`           | `RCLONE_CONFIG_ZAMFONO_TYPE=ftp`, `_HOST`, `_USER`, `_PASS`; for `ftps` also `_EXPLICIT_TLS=true` |
   | `webdav`      | `rclone:zamfono:<path>`           | `RCLONE_CONFIG_ZAMFONO_TYPE=webdav`, `_URL`, `_USER`, `_PASS`                                     |

   Only a surviving host still has the `local` repository. `_HOST` and the other short names stand
   for `RCLONE_CONFIG_ZAMFONO_HOST` and so on. rclone takes `_PASS` obscured, never plain:
   `docker compose run --rm --no-deps --entrypoint rclone api obscure '<password>'` prints the
   value to set. For `sftp`, ssh gets the password through `sshpass`, which restic is told about
   with an option after `restic restore latest`:
   `-o "sftp.command=sshpass -e ssh -o StrictHostKeyChecking=accept-new -l <username> <host> -s sftp"`.

5. With continuous replication, replace the database with Litestream's newer copy, through the
   sidecar of `compose.dr.yaml`, which mounts the `db` volume at `/data`, as uid 1000 like every
   container writing that volume. The restic step above still brings the media. Litestream
   refuses to restore over an existing database, so the restic copy and its `-wal` and `-shm`
   files go first:

   ```bash
   ./setup/compose.sh run --rm --no-deps --entrypoint rm api \
     -f /data/zamfono.sqlite3 /data/zamfono.sqlite3-wal /data/zamfono.sqlite3-shm
   ./setup/compose.sh run --rm --no-deps --user 1000:1000 --entrypoint litestream <sidecar> \
     restore -o /data/zamfono.sqlite3 '<replica URL>'
   ```

6. Start the stack: `docker compose up -d`, or `./setup/compose.sh up -d` with `compose.dr.yaml`;
   on Podman, install the boot unit of step 7. `migrate` applies the migrations of a newer
   release; the first-boot seed does not run, since the database holds users.

With continuous replication, configuration, users and call history are current to within
seconds, and media newer than the last restic run is lost. Without it, everything is as old as
the last restic snapshot.

## Rolling back a release

Migrations only go forward, so a bad release is undone on its own host by restoring the
snapshot the upgrade began with, the backup run taken right before it:

1. Note that run's `snapshotId` from `backups.runs.list` (`GET /backups/runs`), or find the
   snapshot in the list `restic snapshots` prints in place of the `restic restore` command of
   step 4.
2. Stop the stack, as above, and unpack the previous release's bundle (step 2). Where `.env`
   pins `ZAMFONO_VERSION`, set it to that release.
3. Run step 4 with the snapshot's id in place of `latest`. Skip step 5: Litestream's copy already
   holds the bad release's migrations.
4. Start the stack (step 6).

## Conditions

- Pin the Litestream image version exactly. A change of its first non-zero version component
  (0.5 → 0.6 while it is 0.x, 1.x → 2.x from 1.0 on) can change the replica format, so it runs as
  a deliberate migration with a fresh snapshot taken right after; patch releases are ordinary
  updates.
- The replication bucket needs server-side encryption — the WAL stream itself is not
  client-side encrypted, unlike the restic repository.
- `backups.runs.list` (`GET /backups/runs`) and the `backup.finished`/`backup.failed` events show
  the age and status of the restic runs a restore would fall back to. A run's `bytesTotal` is its
  snapshot's full size; `bytesAdded` is only what it uploaded after deduplication, so a run far
  smaller than the one before it is the usual case, not an incomplete backup.
