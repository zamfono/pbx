#!/usr/bin/env bash
# §9.1: every fixed prompt the core plays ships in the asterisk image, for every tenant language
# (§11.4 `settings.language`), in the language's own set or as the English file a prompt missing
# from a community set falls back to. The names come from the running core image itself —
# `prompts.ts`'s `PROMPTS` (menus, voicemail, find-me's accept prompt, §10.1 step 4, the failed-call
# announcement, §9.4) and
# `mailboxPrompts.ts`'s `MAILBOX_PROMPTS` (the `*96`/`*95` menu, §10.2) — so a prompt added to
# the core without shipping it fails here instead of playing silence on a real call.
#
#   prompts.sh <compose>
set -euo pipefail

compose=$1
LANGUAGES='de en es fr it ru'

dc() {
  # shellcheck disable=SC2086 # `$compose` carries the runtime's own multi-word command
  $compose "$@"
}

names=$(dc exec -T core node --input-type=module -e "
const { PROMPTS } = await import('/app/packages/core/dist/prompts.js');
const { MAILBOX_PROMPTS } = await import('/app/packages/core/dist/calls/mailboxPrompts.js');
console.log([...Object.values(PROMPTS), ...Object.values(MAILBOX_PROMPTS)].join(' '));
" | tr -d '\r')
[ -n "$names" ] || { echo 'the core image named no prompts' >&2; exit 1; }

missing=$(dc exec -T asterisk sh -c "
  for name in $names; do
    for lang in $LANGUAGES; do
      [ -f /usr/share/asterisk/sounds/\$lang/\$name.wav ] \
        || [ -f /usr/share/asterisk/sounds/en/\$name.wav ] \
        || echo \"\$lang/\$name\"
    done
  done" | tr -d '\r')
if [ -n "$missing" ]; then
  echo "prompts the core plays are missing from the image: $missing" >&2
  exit 1
fi
# shellcheck disable=SC2086 # one name per word, split by design
echo "   $(printf '%s\n' $names | wc -l | tr -d ' ') prompts ship for every tenant language"
