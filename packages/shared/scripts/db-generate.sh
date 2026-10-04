#!/bin/sh
# Regenerates src/generated/db.d.ts from db/migrations: migrates a fresh database in a temporary
# directory with db/migrate.ts and runs kysely-generate against it. Arguments go to
# kysely-generate, so `--verify` checks the committed file instead of rewriting it.
set -e

shared_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

DB_FILE="$tmp_dir/db.sqlite3" node "$shared_dir/../../db/migrate.ts" >/dev/null
cd "$shared_dir"
DB_FILE="$tmp_dir/db.sqlite3" kysely-generate "$@"
