#!/usr/bin/env sh
# Builds the migrate image and exercises it the way the migrate service runs in the stack (§6.3
# "Migrations"): a first run applies the schema, a second run against the same volume is idle, a
# briefly locked database file is retried until it frees, and a broken extra migration exits 1 at
# once without a retry.
set -eu

cd "$(dirname "$0")"

DATA_DIR=$(mktemp -d)
BROKEN_DIR=$(mktemp -d)
BROKEN_DATA_DIR=$(mktemp -d)
LOCKED_DATA_DIR=$(mktemp -d)
LOCK_HOLDER=
cleanup() {
  [ -z "$LOCK_HOLDER" ] || docker rm -f "$LOCK_HOLDER" >/dev/null 2>&1 || true
  rm -rf "$DATA_DIR" "$BROKEN_DIR" "$BROKEN_DATA_DIR" "$LOCKED_DATA_DIR"
}
trap cleanup EXIT
# mktemp's 0700 keeps the container's uid 1000 out of a directory the host's root created.
chmod 0777 "$DATA_DIR" "$BROKEN_DIR" "$BROKEN_DATA_DIR" "$LOCKED_DATA_DIR"

# CI passes the image it built as MIGRATE_IMAGE, docker-bake.hcl's variable, and nothing is built
# here, so the image checked is the one published. Standalone, bake builds it fresh under :test.
if [ -z "${MIGRATE_IMAGE:-}" ]; then
  MIGRATE_IMAGE=zamfono/migrate:test
  export MIGRATE_IMAGE
  (cd .. && docker buildx bake --load migrate)
fi

echo '== first run: applies the migration =='
docker run --rm -v "$DATA_DIR:/data" -e DB_FILE=/data/zamfono.sqlite3 "$MIGRATE_IMAGE"

echo '== second run: nothing pending =='
second_output=$(docker run --rm -v "$DATA_DIR:/data" -e DB_FILE=/data/zamfono.sqlite3 "$MIGRATE_IMAGE" 2>&1)
echo "$second_output"
echo "$second_output" | grep -qi 'no new migrations' || {
  echo 'expected the idle run to report that no migration is pending' >&2
  exit 1
}

# Read ownership from inside the container: a bind mount under Docker Desktop remaps the
# container's uid 1000 to the host user on the host side, so a host-side stat would not reflect it.
owner_uid=$(docker run --rm -v "$DATA_DIR:/data" --entrypoint stat "$MIGRATE_IMAGE" -c '%u' /data/zamfono.sqlite3)
[ "$owner_uid" = 1000 ] || {
  echo "expected the database file to be owned by uid 1000, got $owner_uid" >&2
  exit 1
}

echo '== locked database: retried until the lock is released =='
# A second process holds an exclusive lock on the fresh database file for 8 s, so the first
# attempt finds it locked and a later one, 5 s apart, applies the migration.
LOCK_HOLDER=$(docker run -d -v "$LOCKED_DATA_DIR:/data" --entrypoint node "$MIGRATE_IMAGE" -e "
  const db = new (require('better-sqlite3'))('/data/zamfono.sqlite3');
  db.exec('BEGIN EXCLUSIVE');
  require('node:fs').writeFileSync('/data/locked', '');
  setTimeout(() => db.exec('COMMIT'), 8000);
")
for _ in $(seq 1 50); do
  [ -e "$LOCKED_DATA_DIR/locked" ] && break
  sleep 0.2
done
[ -e "$LOCKED_DATA_DIR/locked" ] || {
  echo 'the lock holder never took its lock' >&2
  exit 1
}
locked_output=$(docker run --rm -v "$LOCKED_DATA_DIR:/data" -e DB_FILE=/data/zamfono.sqlite3 "$MIGRATE_IMAGE" 2>&1) || {
  echo "$locked_output"
  echo 'expected the migration to succeed once the lock was released' >&2
  exit 1
}
echo "$locked_output"
echo "$locked_output" | grep -q 'found the database locked; retrying in 5s' || {
  echo 'expected the locked database to be retried' >&2
  exit 1
}

echo '== broken extra migration: exits 1 at once, without a retry =='
cp migrations/*.ts "$BROKEN_DIR/"
cat >"$BROKEN_DIR/9999999999999_broken.ts" <<'EOF'
export async function up(): Promise<void> {
  throw new Error('deliberately broken migration');
}
export async function down(): Promise<void> {}
EOF

broken_status=0
broken_output=$(docker run --rm \
  -v "$BROKEN_DATA_DIR:/data" \
  -v "$BROKEN_DIR:/app/db/migrations" \
  -e DB_FILE=/data/zamfono.sqlite3 \
  "$MIGRATE_IMAGE" 2>&1) || broken_status=$?
echo "$broken_output"
[ "$broken_status" = 1 ] || {
  echo "expected the broken migration to exit 1, got $broken_status" >&2
  exit 1
}
echo "$broken_output" | grep -q 'deliberately broken migration' || {
  echo 'expected the broken migration itself to be what failed' >&2
  exit 1
}
echo "$broken_output" | grep -q 'migration failed; not retrying' || {
  echo 'expected the broken migration to fail without a retry' >&2
  exit 1
}
if echo "$broken_output" | grep -q 'retrying in 5s'; then
  echo 'expected no retry of a migration that fails on its own merits' >&2
  exit 1
fi

echo 'db/test.sh: all checks passed'
