# Adding a tenant language

A tenant language (`settings.language`, spec §11.4) sets the language of the phone prompts, the
sign-in pages, the mails and their dates, the Yealink phones and the Ringotel welcome mail. The
tenant languages are exactly the languages the image has prompts for (§9.1). Debian ships prompt
sets for only a few languages, and they join single words into sentences, so a new language gets a
generated set: text-to-speech audio committed to the repository. Polish (`pl`) is the worked
example; every step below points at its files.

You need a native speaker. Every text below is a translation, and the prompts must be heard as a
caller hears them.

## 1. The language code

- `packages/shared/src/columnValues.ts`: add the ISO 639-1 code to `LANGUAGES`. REST, MCP and the
  OpenAPI schema take their values from this list.
- `db/migrations/`: SQLite cannot change a CHECK constraint. Copy
  `1793901640878_polish_language.ts`, which rebuilds `settings` and `mail_templates` from their
  stored definitions with only the language CHECK widened, and change its two lists.
  `packages/shared/src/languages.test.ts` fails until the CHECKs accept every value of `LANGUAGES`.
- `packages/core/src/prompts.ts`: add the code to `GENERATED_LANGUAGES`.

## 2. The prompts

- `packages/core/src/calls/promptSet.ts` lists every prompt the core can play in a generated
  language. Copy `images/asterisk/prompts/pl.json` to `<code>.json` and translate each text.
  - The owner's mailbox menu addresses the owner the way the language's UIs usually do (Polish:
    informal "ty"). Prompts outside callers hear are polite (Polish: "proszę" + infinitive).
  - A `[bracketed]` part is cut out of the sentence around it, so a piece that is joined to other
    pieces keeps the intonation it has mid-sentence. Put a word starting with a stop (p, t) right
    after the cut, so the cut lands in the stop's silence.
  - `aliases` respells words the voice says wrong.
- Counts and numbers: the core reads counts itself, because Asterisk's `number:` has no
  grammatical gender. `packages/core/src/calls/mailboxGrammarPl.ts` holds Polish's plural forms
  (one, few, many), the feminine numerals and the prompts they need. A language with different
  rules gets its own module, registered in `mailboxGrammar.ts` and in `promptSet.ts`'s
  `LANGUAGE_PROMPTS`. Test every count range where the form changes.
- `digits-final/` holds each number's falling form, for a number that ends a sentence (a message's
  place, a parking slot). Where the language's intonation rises inside a sentence and falls at its
  end, it needs these too.
- Generate the set:

  ```sh
  secrets node scripts/generate-prompts.mjs <code>              # every prompt
  secrets node scripts/generate-prompts.mjs <code> vm-intro …   # only these
  ```

  The ElevenLabs key comes from Infisical. A full set costs about 10,500 characters of credit (the Polish manifest).
  Regenerate single prompts rather than the whole set while iterating.

- `images/asterisk/Dockerfile`: add `COPY prompts/<code> /usr/share/asterisk/sounds/<code>`.
- `packages/core/src/calls/promptSet.test.ts` checks that the manifest and the files hold every
  prompt the core can play. `test/integration/prompts.sh` checks the same thing in the built image.

### Listening

A clip that sounds right on its own can sound wrong next to the others. Have the native speaker
listen to the sequences the core plays, joined. Take them from the core's media functions
(`introMedia`, `mainMenuMedia`, `messageHeaderMedia`, `messageOptionsMedia`, `digitsMedia`) after
`tsc -b`, and join the clips with ffmpeg:

```sh
ffmpeg -f g722 -i a.g722 -f g722 -i b.g722 -filter_complex '[0:a][1:a]concat=n=2:v=0:a=1' out.wav
```

Cover every count form (0, 1, 2–4, 5, 12–14, 22, 100+), both folders, the full main menu, a
message's options, a parking slot and the caller-facing prompts. Listen for clipped word ends, for
rough joins inside numbers, and for a voice that rises where a sentence ends.

## 3. Pages and mails

- `packages/api/src/lib/i18n/<code>.json`: the sign-in, two-factor, password and upload pages.
  Register it in `i18n/index.ts`.
- `packages/api/src/lib/server/mail/builtin/<template>.<code>.json`: all seven built-in mails.
  Add the code to `BUILTIN_LANGUAGES` in `render.test.ts`, with its words for a withheld number
  and a length.
- Placeholders such as names, companies and phone numbers are never declined. In a language with
  grammatical cases, don't put one after a preposition that needs a case ("od {{callerName}}"):
  use a labelled field ("Dzwoniący: {{callerName}}") or a noun that carries the case ("do systemu
  telefonicznego {{companyName}}"). Avoid verbs that agree with the reader's gender.

### Review

Before the native speaker reviews the texts, have them checked by a reviewer with no context: a
subagent that knows only the files and the language. Ask it to check:

- placeholders and Handlebars blocks against the English;
- placeholders after case-governing prepositions, where the mail renders the name undeclined;
- gendered forms addressed to the reader;
- the register: the UI's usual address, polite for callers;
- pronouns in the voice menu that point at the wrong thing (the message options play "previous",
  "next" and then "delete it");
- calques of the English and the established local terms (two-factor authentication, passkey,
  security key, saved messages).

## 4. Phones and apps

- Yealink: add the language's name to `LANGUAGE_NAMES` in
  `packages/api/src/lib/server/provisioning/yealink.ts`. Use the value Yealink documents for
  `lang.gui` and `lang.wui` (the T73U language page lists them), and add it to `yealink.test.ts`.
- Ringotel: the organization's `lang` is the tenant language if `RINGOTEL_LANGUAGES`
  (`provisioning/ringotelBranchHooks.ts`) lists it, and English otherwise. Check the Shell's
  current `emailLangs` (in the Shell's `main-*.js`). Update the list if it has changed, and note
  the date.

## 5. Docs

- `docs/spec.md`: §9.1 (prompt sets) and the `language` row in §11.4.
- `docs/spec-changes.md` and `CHANGELOG.md`.
- `docs/guide/mail-templates.md` names the number of languages. Run `scripts/build-skill.sh`
  afterwards.
