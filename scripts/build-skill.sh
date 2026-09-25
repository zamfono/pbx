#!/bin/sh
# Rebuilds skills/zamfono/reference/ (§12 "Admin skill", Task 46): the admin guide sections that
# zamfono.help also serves, plus a tool catalog generated from the operations registry, so the
# skill's reference cannot drift from either source. SKILL.md itself is hand-written and untouched.
set -e

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
reference_dir="$repo_root/skills/zamfono/reference"
tmp_dir=$(mktemp -d "$repo_root/skills/zamfono/.reference.build.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT

# Guides first, recipes second and only where no guide of the same name already landed: this
# matches `guide.ts`'s own precedence (a guide topic wins over a recipe of the same name), so
# `zamfono.help` and this flat copy agree on which file a colliding name serves.
cp "$repo_root"/docs/guide/*.md "$tmp_dir/"
for recipe in "$repo_root"/docs/guide/recipes/*.md; do
  target="$tmp_dir/$(basename "$recipe")"
  if [ ! -e "$target" ]; then
    cp "$recipe" "$target"
  fi
done
node "$repo_root/packages/api/scripts/tool-catalog.mjs" >"$tmp_dir/tools.md"

rm -rf "$reference_dir"
mv "$tmp_dir" "$reference_dir"
trap - EXIT
