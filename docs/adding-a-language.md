# Adding a tenant language

A tenant language (`settings.language`, spec §11.4) sets the language of the phone prompts, the
sign-in pages, the mails and their dates, the Yealink phones and the Ringotel welcome mail. The
tenant languages are exactly the languages the image has prompts for (§9.1): every language has
two generated sets, text-to-speech audio committed to the repository. Polish (`pl`) is the worked
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

## 2. The prompts

- `packages/core/src/calls/promptSet.ts` lists every prompt the core can play in a generated
  language. Copy `images/asterisk/prompts/pl.json` to `<code>.json` and translate each text.
  - The owner's mailbox menu addresses the owner the way the language's UIs usually do (Polish:
    informal "ty"). Prompts outside callers hear are polite (Polish: "proszę" + infinitive).
  - Where a prompt is a piece the core joins to others, put it in `[brackets]` inside a sentence
    that uses it: only the bracketed part is spoken, and the words around it go to ElevenLabs as
    context, so the piece keeps the intonation it has mid-sentence (or at the end, for a piece
    that ends what the caller hears).
  - `voices` names the ElevenLabs voice of each of the language's two sets, `female` and `male`,
    by name and id. Pick them with the native speaker from the voice library's previews. Tenants
    choose between them with `settings.promptVoice`.
  - `aliases` respells words the voices say wrong (Russian: a stress mark, `положи́те`).
  - Before generating, have a reviewer with no context compare the wording with what carriers
    and business phone systems in that language say (web search; Asterisk's own core-sounds
    transcripts are a good source), and fix the manifest. Tell it where each prompt plays and who
    hears it: callers get the polite form; `pbx-invalid` follows both no key and a wrong one;
    `vm-sorry` follows both a wrong key and a greeting recording that failed; `vm-msgsaved`
    confirms the greeting.
- Counts and numbers: the core reads counts itself, because Asterisk's `number:` has no
  grammatical gender. `mailboxGrammarGenerated.ts` (in `packages/core/src/calls/`) builds the
  intro and the message header from a language's plural categories, its category for a count and
  its number reading. `mailboxGrammarDe.ts` is the simple case (one, other); `mailboxGrammarPl.ts`
  adds Polish's few and many and the feminine numerals. A new language gets its own module,
  registered in `mailboxGrammar.ts` and in `promptSet.ts`'s `LANGUAGE_PROMPTS`. Test every count
  range where the form changes.
- `digits-final/` holds each number's falling form, for a number that ends a sentence (a message's
  place, a parking slot). Where the language's intonation rises inside a sentence and falls at its
  end, it needs these too.
- Generate both sets:

  ```sh
  secrets node scripts/generate-prompts.mjs <code> female              # every prompt
  secrets node scripts/generate-prompts.mjs <code> male
  secrets node scripts/generate-prompts.mjs <code> female vm-intro …   # only these
  ```

  The ElevenLabs key comes from Infisical. The Polish male set used about 2,400 credits on
  `eleven_v4`, retries included, so a language's two sets take about 5,000. Every answer is
  cached in `.cache/prompts/`, so a rerun pays only for prompts whose text changed. The plan
  allows three requests at a time; run at most three generators at once (a busy plan's 429 is
  retried).

- `images/asterisk/Dockerfile` and the language loop in `images/asterisk/test.sh`: copy
  `prompts/<code>/female` and `prompts/<code>/male` to `/usr/share/asterisk/sounds/<code>_female`
  and `<code>_male`, the channel languages the core sets.
- `packages/core/src/calls/promptSet.test.ts` checks that the manifest and the files hold every
  prompt the core can play. `test/integration/prompts.sh` checks the same thing in the built image.

### Listening

The generator reads every clip back with ElevenLabs speech-to-text and ends with a list of the
ones that did not read as their text: listen to those first. Very short words often come back
empty or misheard (`sto` as "Stop") although they sound right, and a transcript tells a wrong or
missing word, not a clipped sound, so the list never replaces listening. ElevenLabs sometimes
breaks a word off mid-vowel and speech-to-text still hears it right; Joanna's `sto` was one.

Where a clip sounds wrong, pin another seed for it in the voice's `seeds`
(`"seeds": { "digits/100": 1 }`) and regenerate that prompt. A pinned clip is kept without the
speech-to-text check, so the listener's ear decides.

A clip that sounds right on its own can sound wrong next to the others. Have the native speaker
listen to the sequences the core plays, joined, in the prompt playground:

```sh
npx tsc -b && node scripts/prompt-playground.mjs    # http://127.0.0.1:4310
```

It joins the committed clips the core's own media functions name for a language, a voice and what
the core plays: the mailbox intro for any counts, the main menu, a message's header and options, a
parking slot, one prompt, or any clips by name. Do this for both voices. Cover every count form
(0, 1, 2–4, 5, 12–14, 22, 100+), both folders, the full main menu, a message's options, a parking
slot and the caller-facing prompts. Listen for clipped word ends, for
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
