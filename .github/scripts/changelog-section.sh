#!/usr/bin/env bash
# Prints the body of CHANGELOG.md's section for one release, the text between its
# `## [X.Y.Z] - <date>` heading and the next `## [` heading or the link definitions at the end:
# the GitHub release's description (release.yaml). Exits 1 when the file has no such section, or
# only an empty one, so a tag nobody wrote notes for publishes no release.
#
#   changelog-section.sh X.Y.Z [CHANGELOG.md]
set -euo pipefail

version=${1:?usage: changelog-section.sh X.Y.Z [CHANGELOG.md]}
file=${2:-$(cd "$(dirname "$0")/../.." && pwd)/CHANGELOG.md}

body=$(awk -v v="$version" '
  index($0, "## [" v "] ") == 1 { found = 1; next }
  found && (/^## \[/ || /^\[[^]]+\]: /) { exit }
  found { print }
' "$file" | sed -e '/./,$!d' | sed -e ':a' -e '/^\n*$/{$d;N;ba' -e '}')

# CHANGELOG.md wraps its lines at 100 columns; GitHub renders every line break in a release's
# description, so each wrapped paragraph and list item is joined back into one line. Code blocks
# are left exactly as written.
body=$(printf '%s\n' "$body" | awk '
  /^ *```/ { if (held != "") { print held; held = "" } fence = !fence; print; next }
  fence { print; next }
  /^$/ || /^#/ { if (held != "") { print held; held = "" } print; next }
  /^ *- / { if (held != "") print held; held = $0; next }
  { line = $0; sub(/^ +/, "", line); held = (held == "") ? $0 : held " " line }
  END { if (held != "") print held }
')

if [ -z "$body" ]; then
  echo "changelog-section.sh: $file has no section for $version (a '## [$version] - <date>' heading)" >&2
  exit 1
fi
printf '%s\n' "$body"
