# shellcheck shell=bash
# Sourced by update-test.sh: update.sh's --check verdicts and --current, on the stack and the
# release server update-test.sh set up (`work`, `port`, `fresh_stack`, `fail`).

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
# The release an update stopped at is not newer either, though a run finishes that update.
echo 1.2.3 >"$work/stack/.update-pending"
[[ $(check_status 1.2.3 1.2.3 ZAMFONO_UPDATER=1) == 11 ]] ||
  fail "--check on an unfinished update did not exit 11: $(cat "$work/out")"
rm "$work/stack/.update-pending"
# A directory that names no release: no .env pin, no VERSION.
sed -i '/^ZAMFONO_VERSION=/d' "$work/stack/.env"
rm "$work/stack/VERSION"
status=0
(cd "$work/stack" && ZAMFONO_UPDATER=1 ZAMFONO_REPO_URL="http://127.0.0.1:$port" \
  ./update.sh --check 1.2.4 </dev/null >"$work/out" 2>&1) || status=$?
[[ $status == 12 ]] || fail "--check without a release exited $status, not 12: $(cat "$work/out")"

echo "  - --current: the last ZAMFONO_VERSION .env pins, else VERSION, else exit 12"
fresh_stack
current() { (cd "$work/stack" && ZAMFONO_UPDATER=1 ./update.sh --current </dev/null); }
sed -i '/^ZAMFONO_VERSION=/d' "$work/stack/.env"
[[ $(current) == 1.2.3 ]] || fail "--current did not read VERSION: $(current 2>&1)"
printf "ZAMFONO_VERSION='1.2.1'\nZAMFONO_VERSION=\"1.2.2\"\n" >>"$work/stack/.env"
[[ $(current) == 1.2.2 ]] || fail "--current did not read the last .env pin: $(current 2>&1)"
sed -i '/^ZAMFONO_VERSION=/d' "$work/stack/.env"
rm "$work/stack/VERSION"
status=0
current >/dev/null 2>&1 || status=$?
[[ $status == 12 ]] || fail "--current without a release exited $status, not 12"
[[ ! -e $work/stack/.update ]] || fail "--current wrote $(ls "$work/stack/.update")"
fresh_stack
