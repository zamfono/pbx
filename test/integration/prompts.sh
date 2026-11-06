#!/usr/bin/env bash
# §9.1: every prompt the core can play ships in the asterisk image, for every tenant language
# (§11.4 `settings.language`) and voice (`settings.prompt_voice`): the generated set
# `<language>_<voice>` holds each name `promptSet.ts`'s `generatedPromptNames` lists for its
# language, in both formats it ships, with no fallback to another language's file. The names come
# from the running core image itself, so a prompt added to the core without shipping it fails here
# instead of playing silence on a real call.
#
#   prompts.sh <compose>
set -euo pipefail

compose=$1
# shellcheck source=../api.sh
. "$(dirname "$0")/../api.sh"

names=$(dc exec -T core node --input-type=module -e "
const { generatedPromptNames } = await import('/app/packages/core/dist/calls/promptSet.js');
const { LANGUAGES, PROMPT_VOICES } = await import('/app/packages/shared/dist/index.js');
console.log(LANGUAGES
  .flatMap(lang => PROMPT_VOICES.flatMap(voice =>
    generatedPromptNames(lang).map(name => lang + '_' + voice + '/' + name))).join(' '));
" | tr -d '\r')
[ -n "$names" ] || { echo 'the core image named no prompts' >&2; exit 1; }
missing=$(dc exec -T asterisk sh -c "
  for name in $names; do
    for format in wav g722; do
      [ -f /usr/share/asterisk/sounds/\$name.\$format ] || echo \"\$name.\$format\"
    done
  done" | tr -d '\r')
if [ -n "$missing" ]; then
  echo "prompts the core plays are missing from the image: $missing" >&2
  exit 1
fi
# shellcheck disable=SC2086 # one name per word, split by design
echo "   $(printf '%s\n' $names | wc -l | tr -d ' ') prompts ship in the sets of every language and voice"
