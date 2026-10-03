# Sourced by `run.sh`: with `UPGRADE_FROM` set, the stack starts as that release instead, from its
# own published bundle and images, and is then upgraded to the build under test the way
# deploy/README.md step 8 upgrades an operator's stack (§6.3 "Upgrades"). What that release's first
# boot seeded is read through its API before the upgrade and must read the same after it.
#
#   UPGRADE_FROM=latest   the newest vX.Y.Z tag of the repository
#   UPGRADE_FROM=X.Y.Z    that release
#
# The release must be one the build under test upgrades from: 0.2.0 or later, since a 0.1.x stack
# is not upgraded (installed anew instead).
#
# Reads and sets `run.sh`'s own COMPOSE, compose_args, run_dir, here, api_base, RUNTIME,
# OWNER_EMAIL, OWNER_PASSWORD, FQDN and fail.

UPGRADE_REPO=https://github.com/zamfono/pbx
UPGRADE_REGISTRY=ghcr.io/zamfono
# What the survival check reads: the rows the previous release's first boot seeded (§6.3 "First
# boot"), each through an endpoint every release serves.
UPGRADE_SNAPSHOT_PATHS=(/settings /users /dids /parking/slots /audio)

# The version `UPGRADE_FROM` names, without its `v`.
upgrade_version() {
  if [ "$UPGRADE_FROM" != latest ]; then
    echo "${UPGRADE_FROM#v}"
    return
  fi
  git ls-remote --tags --refs "$UPGRADE_REPO" 'v*' \
    | sed -n 's#.*refs/tags/v\([0-9]*\.[0-9]*\.[0-9]*\)$#\1#p' | sort -V | tail -n 1
}

# The previous release's API, read with a token of its own, into one JSON document per path.
upgrade_snapshot() {
  local out=$1 token path
  token=$(bash "$here/bootstrap-token.sh" "$api_base" "$OWNER_EMAIL" "$OWNER_PASSWORD" "https://$FQDN") \
    || fail "could not obtain an access token from the release upgraded from"
  : >"$out"
  for path in "${UPGRADE_SNAPSHOT_PATHS[@]}"; do
    printf '%s\t' "$path" >>"$out"
    api GET "$path" >>"$out" \
      || fail "GET $path did not answer on the release upgraded from"
    echo >>"$out"
  done
}

# Starts `$1`'s stack: its bundle unpacked into the stack directory, its images from the
# registry, and the overlay and `.env` this run uses for the build under test.
upgrade_start_previous() {
  local version=$1
  curl -fsSL "$UPGRADE_REPO/releases/download/v$version/zamfono-deploy.tar.gz" \
    | tar xz -C "$run_dir" --strip-components=1 \
    || fail "could not download the v$version release bundle"
  echo "== §6.3 Upgrades: starting v$version from its own bundle and images =="
  ASTERISK_IMAGE=$UPGRADE_REGISTRY/asterisk:$version MIGRATE_IMAGE=$UPGRADE_REGISTRY/migrate:$version \
    CORE_IMAGE=$UPGRADE_REGISTRY/core:$version API_IMAGE=$UPGRADE_REGISTRY/api:$version \
    PROXY_IMAGE=$UPGRADE_REGISTRY/proxy:$version stack_recreate
}

# The upgrade itself, as deploy/README.md step 8 gives it, by `update.sh`: the build under test's
# files over the stack directory's, as unpacking its bundle puts them, then the stack recreated
# the way update.sh recreates it (`stack_recreate`). The images are the build's own, already
# loaded, so there is nothing to pull.
upgrade_to_build() {
  echo "== §6.3 Upgrades: upgrading to the build under test ($RUNTIME) =="
  stack_dir_files "$run_dir"
  stack_recreate
  upgrade_assert_images
}

# Every one of the stack's five services now runs the build's own image, not the release's.
# Podman names a local image `localhost/…` and a Hub one `docker.io/…`; neither prefix counts.
upgrade_assert_images() {
  local service expected running
  for service in asterisk migrate core api proxy; do
    case $service in
      asterisk) expected=${ASTERISK_IMAGE:-zamfono/asterisk:ci} ;;
      migrate) expected=${MIGRATE_IMAGE:-zamfono/migrate:ci} ;;
      core) expected=${CORE_IMAGE:-zamfono/core:ci} ;;
      api) expected=${API_IMAGE:-zamfono/api:ci} ;;
      proxy) expected=$PROXY_IMAGE ;;
    esac
    running=$($COMPOSE "${compose_args[@]}" ps -a --format '{{.Service}} {{.Image}}' \
      | awk -v s="$service" '$1 == s { print $2 }' | sed -E 's#^(localhost|docker\.io)/##')
    [ "$running" = "${expected#docker.io/}" ] \
      || fail "after the upgrade $service runs '${running:-nothing}', not the build's $expected"
  done
}

# Every row the previous release served is served again, with every field it had then unchanged; a
# release may add fields and rows.
upgrade_verify() {
  local before=$1 after=$2
  echo '== §6.3 Upgrades: what the previous release seeded reads the same after the upgrade =='
  python3 - "$before" "$after" <<'PY' || fail "the upgrade changed or lost data the previous release held"
import json, sys

def load(path):
    docs = {}
    for line in open(path, encoding='utf-8'):
        key, _, body = line.rstrip('\n').partition('\t')
        docs[key] = json.loads(body)
    return docs

def rows(doc):
    return {row['id']: row for row in doc['items']} if isinstance(doc, dict) and 'items' in doc else {'': doc}

problems = []
before, after = load(sys.argv[1]), load(sys.argv[2])
for path, doc in before.items():
    now = rows(after[path])
    for key, row in rows(doc).items():
        if key not in now:
            problems.append(f'{path}: {key or "the document"} is gone')
            continue
        for field, value in row.items():
            if now[key].get(field) != value:
                problems.append(f'{path} {key}: {field} was {value!r}, is {now[key].get(field)!r}')
    print(f'   {path}: {len(rows(doc))} row(s) checked')
for problem in problems:
    print(problem, file=sys.stderr)
sys.exit(1 if problems else 0)
PY
}

# The whole upgrade: the previous release up and ready, its data read, the upgrade, which leaves
# the stack for `assert_migrated` to check as it checks a fresh one. Leaves the snapshot's path
# in UPGRADE_BEFORE for `upgrade_verify`, once `run.sh` has its own token.
upgrade_from_release() {
  local version
  version=$(upgrade_version)
  [ -n "$version" ] || fail "UPGRADE_FROM=$UPGRADE_FROM names no release"
  UPGRADE_BEFORE=$run_dir/upgrade-before.tsv
  upgrade_start_previous "$version"
  assert_migrated
  upgrade_snapshot "$UPGRADE_BEFORE"
  upgrade_to_build
}
