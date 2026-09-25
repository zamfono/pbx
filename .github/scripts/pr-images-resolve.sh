#!/bin/bash
# Decides whether pr-images.yaml publishes a pull request's images, and which ones: the pull
# request, the head commit, and the ci run whose `images` archive holds them. Run by its
# `resolve` job, from the default branch, never from the pull request's code.
#
# Usage: pr-images-resolve.sh workflow_run <ci run id> <head sha> <head repo>
#        pr-images-resolve.sh labeled <pr number> <head sha>
# The first form is a finished ci run (the event's workflow_run), the second a label just added
# (the event's pull_request, with the head it had when labelled). Environment: GH_TOKEN, REPO
# (owner/name), LABEL; GITHUB_OUTPUT receives publish=true|false and, when true, pr, sha, run_id
# and source (the head repository's URL).
#
# Everything is looked up through the API when this runs and matched against the event: nothing
# comes from the archive, which the pull request's own ci run produced. Publishing needs the pull
# request open, carrying LABEL, with the head that ci run built still its head, and the run a
# successful pull_request run of .github/workflows/ci.yaml from that head repository.
set -euo pipefail

sha_re='^[0-9a-f]{40}$'
num_re='^[1-9][0-9]*$'
repo_re='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'

out() { echo "$1" >>"${GITHUB_OUTPUT:-/dev/stdout}"; }
skip() {
  echo "::notice::not publishing: $1"
  out publish=false
  exit 0
}
fail() {
  echo "::error::$1" >&2
  exit 1
}

mode=${1:-}
case "$mode" in
  workflow_run)
    [ $# -eq 4 ] || fail "usage: $0 workflow_run <run id> <head sha> <head repo>"
    run_id=$2 sha=$3 head_repo=$4
    [[ $run_id =~ $num_re ]] || fail "run id '$run_id' is not a number"
    [[ $head_repo =~ $repo_re ]] || fail "head repository '$head_repo' is not owner/name"
    ;;
  labeled)
    [ $# -eq 3 ] || fail "usage: $0 labeled <pr number> <head sha>"
    pr=$2 sha=$3 run_id='' head_repo=''
    [[ $pr =~ $num_re ]] || fail "pull request '$pr' is not a number"
    ;;
  *) fail "usage: $0 workflow_run|labeled …" ;;
esac
[[ $sha =~ $sha_re ]] || fail "head sha '$sha' is not a full commit sha"
: "${REPO:?}" "${LABEL:?}" "${GH_TOKEN:?}"
[[ $REPO =~ $repo_re ]] || fail "REPO '$REPO' is not owner/name"

if [ "$mode" = workflow_run ]; then
  # A fork's run carries no pull_requests; the open pull request whose head is this commit, from
  # this repository, is the one it ran for. Two of them would leave the choice to a guess.
  prs=$(gh api --paginate "/repos/$REPO/pulls?state=open&per_page=100" \
    --jq ".[] | select(.head.sha == \"$sha\" and .head.repo.full_name == \"$head_repo\") | .number")
  count=$(grep -c . <<<"$prs" || true)
  [ "$count" -eq 1 ] || skip "$count open pull requests have head $sha from $head_repo"
  pr=$prs
  run=$(gh api "/repos/$REPO/actions/runs/$run_id")
else
  # The newest successful ci run of this head; none yet means the workflow_run trigger publishes
  # when it finishes, since the label is already on.
  run_id=$(gh api "/repos/$REPO/actions/workflows/ci.yaml/runs?head_sha=$sha&event=pull_request&status=success&per_page=1" \
    --jq '.workflow_runs[0].id // empty')
  [ -n "$run_id" ] || skip "no successful ci run of $sha yet; its completion will publish"
  run=$(gh api "/repos/$REPO/actions/runs/$run_id")
fi

# The run, checked against itself rather than trusted from the event.
jq -e --arg sha "$sha" '.path == ".github/workflows/ci.yaml" and .event == "pull_request"
    and .conclusion == "success" and .head_sha == $sha' <<<"$run" >/dev/null \
  || fail "run $run_id is not a successful pull_request run of ci.yaml at $sha"
run_repo=$(jq -r '.head_repository.full_name' <<<"$run")
# ci.yaml keeps the archive for a day; a label added later needs a fresh run of ci first.
gh api "/repos/$REPO/actions/runs/$run_id/artifacts?name=images" \
  --jq '.artifacts | any(.expired == false)' | grep -qx true \
  || skip "run $run_id has no unexpired images archive; re-run its ci, which then publishes"

pull=$(gh api "/repos/$REPO/pulls/$pr")
state=$(jq -r .state <<<"$pull")
current=$(jq -r .head.sha <<<"$pull")
pr_repo=$(jq -r '.head.repo.full_name // empty' <<<"$pull")
[ "$state" = open ] || skip "pull request #$pr is $state"
[ "$current" = "$sha" ] || skip "pull request #$pr has moved on to $current; its own ci run decides for that head"
[ "$pr_repo" = "$run_repo" ] || skip "run $run_id built $run_repo, pull request #$pr comes from ${pr_repo:-a deleted repository}"
[ -z "$head_repo" ] || [ "$head_repo" = "$pr_repo" ] || skip "the event names $head_repo, pull request #$pr $pr_repo"
jq -e --arg label "$LABEL" 'any(.labels[]; .name == $label)' <<<"$pull" >/dev/null \
  || skip "pull request #$pr does not carry the '$LABEL' label"

echo "publishing #$pr at $sha from run $run_id ($pr_repo)"
out publish=true
out "pr=$pr"
out "sha=$sha"
out "run_id=$run_id"
out "source=https://github.com/$pr_repo"
