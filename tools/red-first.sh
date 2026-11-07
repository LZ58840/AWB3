#!/usr/bin/env bash
# Red before green (plan 7.5): each test that this checkout adds to test/ must fail on the base ref.
#   bash tools/red-first.sh --base origin/main        npm run test:red-first -- --base origin/main
# RED_FIRST_SKIP=1 skips the check (the workflow sets it for the label no-behavior).
# Steps: list the tests of the head (this working tree) and of the base, copy the head's test/ onto a worktree of the base and run it
# there, then red-first.mjs decides which tests are new and whether each one failed for the right reason. Exit: 0 ok, 1 not red, 2 error.
set -euo pipefail

if [ "${RED_FIRST_SKIP:-}" = 1 ]; then echo 'red-first: skipped (RED_FIRST_SKIP=1, label no-behavior)'; exit 0; fi
if [ $# -ne 2 ] || [ "$1" != --base ] || [ -z "$2" ]; then echo 'usage: red-first.sh --base <ref>' >&2; exit 2; fi
base=$2
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
head=$(git rev-parse --show-toplevel)
git rev-parse --verify --quiet "$base^{commit}" >/dev/null || { echo "red-first: unknown ref '$base' (git fetch it first)" >&2; exit 2; }
vitest=$head/node_modules/.bin/vitest
[ -x "$vitest" ] || { echo 'red-first: run npm ci first, node_modules/.bin/vitest is missing' >&2; exit 2; }

tmp=$(mktemp -d)
work=$tmp/base
cleanup() {
  rm -f "$work/node_modules" # a link to the real node_modules: remove it first, so that no recursive delete reaches the target
  git -C "$head" worktree remove --force "$work" 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT
git -C "$head" worktree add --detach --quiet "$work" "$base"
rm -f "$work/node_modules" # never let ln put the link inside a node_modules link that the base tracks
ln -s "$head/node_modules" "$work/node_modules"

# vitest in $1 with the JSON report in $2; more arguments follow. A red exit code is normal here: the report is what counts.
report() {
  local dir=$1 out=$2
  shift 2
  (cd "$dir" && NO_COLOR=1 "$vitest" run --no-allowOnly --passWithNoTests --reporter=json --outputFile="$out" "$@" >"$out.log" 2>&1) || true
  [ -s "$out" ] || { echo "red-first: vitest wrote no report in $dir:" >&2; tail -n 20 "$out.log" >&2; exit 2; }
}

# -t '(?!)' matches no test name: the files load and the tests are listed, but no test runs.
report "$head" "$tmp/head.json" -t '(?!)'
report "$work" "$tmp/base.json" -t '(?!)'
# shortcut: the cross run takes every test file of the head, not only the files with new tests. Pass those files to vitest if it gets slow.
rm -rf "$work/test"
cp -a "$head/test" "$work/test"
report "$work" "$tmp/cross.json"
node "$here/red-first.mjs" "$head" "$work" "$tmp/head.json" "$tmp/base.json" "$tmp/cross.json" "$base"
