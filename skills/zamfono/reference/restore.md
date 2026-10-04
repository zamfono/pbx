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

The commands are Docker's; on Podman, `podman compose` takes the same arguments.

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
   as `media/`:

   ```bash
   docker compose run --rm --no-deps --entrypoint sh \
     -e RESTIC_REPOSITORY='<repository>' -e RESTIC_PASSWORD='<password>' api -c '
       restic restore latest --target /tmp/restore &&
       cp /tmp/restore/tmp/zamfono-backup/*/zamfono.sqlite3 /data/zamfono.sqlite3 &&
       cp -a /tmp/restore/media/. /media/'
   ```

   For the default `local` target, which only a surviving host still has, the repository is
   `/backups/restic` and the password `BACKUP_PASSWORD` from `.env`. For another target, add the
   backend's variables as restic documents them (for `s3`, `AWS_ACCESS_KEY_ID` and
   `AWS_SECRET_ACCESS_KEY`).

5. With continuous replication, replace the database with Litestream's newer copy, through the
   sidecar of `compose.dr.yaml`, which mounts the `db` volume at `/data`, as uid 1000 like every
   container writing that volume. The restic step above still brings the media.

   ```bash
   ./setup/compose.sh run --rm --no-deps --user 1000:1000 <sidecar> \
     litestream restore -o /data/zamfono.sqlite3 '<replica URL>'
   ```

6. Start the stack: `docker compose up -d`, or `./setup/compose.sh up -d` with `compose.dr.yaml`;
   on Podman, install the boot unit of step 7. `migrate` applies the migrations of a newer
   release; the first-boot seed does not run, since the database holds users.

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
  the age and status of the restic runs a restore would fall back to. A run's `bytesTotal` is its
  snapshot's full size; `bytesAdded` is only what it uploaded after deduplication, so a run far
  smaller than the one before it is the usual case, not an incomplete backup.
