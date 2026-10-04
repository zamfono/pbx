# shellcheck shell=bash
# Sourced by update-test.sh: update.sh's --check verdicts, --current, and ZAMFONO_VERSION's forms
# (.env.example), on the stack and the release server update-test.sh set up (`work`, `port`,
# `fresh_stack`, `fail`, `update`, `pin`).

echo "  - --check: RELEASING.md's policy, its verdict as the exit status the updater reads"
# check_status FROM TO [ENV...] — --check's exit status for TO on a stack .env pins at FROM, its
# text in $work/out; no run of it may leave a record.
check_status() {
  local from=$1 to=$2 status=0
  shift 2
  sed -i '/^ZAMFONO_VERSION=/d' "$work/stack/.env"
  echo "ZAMFONO_VERSION=$from" >>"$work/stack/.env"
  (cd "$work/stack" && env "$@" ZAMFONO_REPO_URL="http://127.0.0.1:$port" \
    ./update.sh --check "$to" </dev/null >"$work/out" 2>&1) || status=$?
  [[ ! -e $work/stack/.update ]] || fail "$from to $to: --check wrote $(ls "$work/stack/.update")"
  echo "$status"
}
fresh_stack
# from, to, the status: 0 update, 10 breaking, 11 not newer.
while read -r from to expected; do
  [[ -n $from ]] || continue
  for run in host updater; do
    if [[ $run == host ]]; then
      got=$(check_status "$from" "$to" PATH="$work/bin:$PATH" ZAMFONO_RUNTIME=docker)
    else
      got=$(check_status "$from" "$to" ZAMFONO_UPDATER=1)
    fi
    [[ $got == "$expected" ]] ||
      fail "$from to $to: --check ($run) exited $got, not $expected: $(cat "$work/out")"
  done
  case $expected in
    0) grep -qx "$from -> $to (update)" "$work/out" ;;
    10) grep -qx "$from -> $to (breaking update)" "$work/out" ;;
    *) true ;;
  esac || fail "$from to $to: --check said $(cat "$work/out")"
done <<'CASES'
0.0.6 0.0.6 11
1.2.3 1.2.3 11
0.0.6 0.0.5 11
0.1.0 0.0.9 11
1.0.0 0.9.9 11
2.0.0 1.9.9 11
1.10.0 1.9.0 11
0.0.5 0.0.6 0
0.0.5 0.0.7 0
0.0.9 0.0.10 0
0.1.0 0.1.1 0
1.2.3 1.2.4 0
1.2.3 1.3.0 0
1.9.9 1.10.0 0
1.2.3 1.12.0 0
0.0.6 0.1.0 10
0.1.3 0.2.0 10
0.9.0 1.0.0 10
0.0.6 1.0.0 10
1.9.0 2.0.0 10
1.2.3 3.0.0 10
CASES
# The release an update stopped at is one the updater may install: its run finishes that update.
echo 1.2.3 >"$work/stack/.update-pending"
[[ $(check_status 1.2.3 1.2.3 ZAMFONO_UPDATER=1) == 0 ]] ||
  fail "--check on an unfinished update did not exit 0: $(cat "$work/out")"
grep -q 'finishing it' "$work/out" || fail "--check on an unfinished update said $(cat "$work/out")"
rm "$work/stack/.update-pending"
# A directory that names no release: no .env pin, no VERSION.
sed -i '/^ZAMFONO_VERSION=/d' "$work/stack/.env"
rm "$work/stack/VERSION"
status=0
(cd "$work/stack" && ZAMFONO_UPDATER=1 ZAMFONO_REPO_URL="http://127.0.0.1:$port" \
  ./update.sh --check 1.2.4 </dev/null >"$work/out" 2>&1) || status=$?
[[ $status == 12 ]] || fail "--check without a release exited $status, not 12: $(cat "$work/out")"

echo "  - --current: by ZAMFONO_VERSION's form, the last line .env sets; else VERSION, else exit 12"
fresh_stack
current() { (cd "$work/stack" && ZAMFONO_UPDATER=1 ./update.sh --current </dev/null); }
# current_is TAG EXPECTED — with .env setting TAG (- for none), --current prints EXPECTED, or
# exits with the status EXPECTED names after a colon.
current_is() {
  local got status=0
  sed -i '/^ZAMFONO_VERSION=/d' "$work/stack/.env"
  [[ $1 == - ]] || echo "ZAMFONO_VERSION=$1" >>"$work/stack/.env"
  got=$(current 2>"$work/out") || status=$?
  ((status == 0)) || got=":$status"
  [[ $got == "$2" ]] || fail "--current with ZAMFONO_VERSION=$1 gave $got, not $2: $(cat "$work/out")"
}
while read -r tag expected; do
  current_is "$tag" "$expected"
done <<'CASES'
- 1.2.3
'' 1.2.3
latest 1.2.3
1.2 1.2.3
1 1.2.3
1.2.1 1.2.1
"0.9.1" 0.9.1
42 1.2.3
edge edge
sha-0123abc :12
42-0123abc :1
v1.2.3 :1
1.2.3.4 :1
sha-0123ab :1
42-0123abcd :1
stable :1
CASES
printf "ZAMFONO_VERSION='1.2.1'\nZAMFONO_VERSION=\"1.2.2\"\n" >>"$work/stack/.env"
[[ $(current) == 1.2.2 ]] || fail "--current did not read the last .env line: $(current 2>&1)"
rm "$work/stack/VERSION"
current_is - :12
current_is 1.2 :12
current_is 1.2.1 1.2.1
[[ ! -e $work/stack/.update ]] || fail "--current wrote $(ls "$work/stack/.update")"

echo "  - an update moves ZAMFONO_VERSION by its form; a sha- build's is refused"
# from, to, ZAMFONO_VERSION before and after (- for none)
while read -r tag to expected; do
  fresh_stack
  sed -i '/^ZAMFONO_VERSION=/d' "$work/stack/.env"
  [[ $tag == - ]] || echo "ZAMFONO_VERSION=$tag" >>"$work/stack/.env"
  update --yes "$to" >"$work/out" 2>&1 || { cat "$work/out"; fail "$tag to $to failed"; }
  got=$(sed -nE "s/^ZAMFONO_VERSION=[\"']?([^\"']*)[\"']?$/\1/p" "$work/stack/.env")
  [[ ${got:--} == "$expected" ]] || fail "ZAMFONO_VERSION=$tag became '$got' on $to, not $expected"
done <<'CASES'
1.2.3 1.2.4 1.2.4
1.2.3 2.0.0 2.0.0
1.2 1.2.4 1.2
1.2 2.0.0 2.0
1 1.3.0 1
1 2.0.0 2
latest 2.0.0 latest
- 1.2.4 -
CASES
for tag in sha-0123abc 42-0123abc stable; do
  fresh_stack
  echo "ZAMFONO_VERSION=$tag" >>"$work/stack/.env"
  update 1.2.4 >"$work/out" 2>&1 && fail "an update ran on ZAMFONO_VERSION=$tag"
  grep -qE 'immutable build|no tag Zamfono publishes' "$work/out" ||
    fail "no word of ZAMFONO_VERSION=$tag: $(cat "$work/out")"
  [[ $(pin) == '1.2.3 ZAMFONO_VERSION:-1.2.3' ]] || fail "ZAMFONO_VERSION=$tag left $(pin)"
done

echo "  - an edge stack: an update pulls the newest edge images and recreates the stack"
fresh_stack
[[ $(check_status edge edge ZAMFONO_UPDATER=1) == 0 ]] ||
  fail "--check edge on an edge stack did not exit 0: $(cat "$work/out")"
grep -qx 'edge -> edge (update)' "$work/out" || fail "--check edge said $(cat "$work/out")"
[[ $(check_status edge 1.2.4 ZAMFONO_UPDATER=1) == 1 ]] || fail "--check 1.2.4 on edge did not fail"
: >"$work/runtime.log"
update >"$work/out" 2>&1 || { cat "$work/out"; fail "the update of an edge stack failed"; }
grep -qx 'compose pull' "$work/runtime.log" || fail "no pull of edge: $(cat "$work/runtime.log")"
grep -qx 'compose up -d --wait --wait-timeout 180' "$work/runtime.log" ||
  fail "no up -d after the edge pull: $(cat "$work/runtime.log")"
[[ $(pin) == '1.2.3 ZAMFONO_VERSION:-1.2.3' ]] || fail "the edge update installed a bundle: $(pin)"
grep -qx 'ZAMFONO_VERSION=edge' "$work/stack/.env" || fail "the edge update changed ZAMFONO_VERSION"
record_is "$work/stack/.update/state.json" succeeded edge edge
update edge >/dev/null 2>&1 || fail "update.sh edge on an edge stack failed"
update 1.2.4 >"$work/out" 2>&1 && fail "an edge stack took release 1.2.4"
grep -q 'follows edge' "$work/out" || fail "no word of edge: $(cat "$work/out")"
fresh_stack
