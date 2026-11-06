/**
 * The mailbox menu's counted phrases (§10.2 "Mailbox access") in each tenant language's own
 * grammar (§9.1), every one a generated set: `mailboxGrammarGenerated.ts` builds the intro ("you
 * have 2 new messages") and a message's header ("new message 2") from each language's module.
 */
import type { Language } from '@zamfono/shared';

import { germanGrammar } from './mailboxGrammarDe.js';
import { englishGrammar } from './mailboxGrammarEn.js';
import { spanishGrammar } from './mailboxGrammarEs.js';
import { frenchGrammar } from './mailboxGrammarFr.js';
import { italianGrammar } from './mailboxGrammarIt.js';
import { polishGrammar } from './mailboxGrammarPl.js';
import { russianGrammar } from './mailboxGrammarRu.js';
import type { Folder } from './mailboxPrompts.js';

const GRAMMARS = {
  de: germanGrammar,
  en: englishGrammar,
  es: spanishGrammar,
  fr: frenchGrammar,
  it: italianGrammar,
  pl: polishGrammar,
  ru: russianGrammar
} satisfies Record<Language, unknown>;

/** "You have 2 new messages and 1 old message", in the channel's language. */
export function introMedia(
  language: Language,
  newCount: number,
  oldCount: number
): string[] {
  return GRAMMARS[language].intro(newCount, oldCount);
}

/** "New message 2", before the message itself. */
export function messageHeaderMedia(
  language: Language,
  folder: Folder,
  position: number
): string[] {
  return GRAMMARS[language].header(folder, position);
}
