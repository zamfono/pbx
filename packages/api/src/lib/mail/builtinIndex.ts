/**
 * The shipped templates, imported by name (§10.2 "Templates"). A glob would be shorter, but only
 * Vite understands one, and this package also bundles through esbuild (`server.ts`); static
 * imports survive either.
 */
import breakingUpdateDe from './builtin/breakingUpdate.de.json' with { type: 'json' };
import breakingUpdateEn from './builtin/breakingUpdate.en.json' with { type: 'json' };
import breakingUpdateEs from './builtin/breakingUpdate.es.json' with { type: 'json' };
import breakingUpdateFr from './builtin/breakingUpdate.fr.json' with { type: 'json' };
import breakingUpdateIt from './builtin/breakingUpdate.it.json' with { type: 'json' };
import breakingUpdateRu from './builtin/breakingUpdate.ru.json' with { type: 'json' };
import missedCallDe from './builtin/missedCall.de.json' with { type: 'json' };
import missedCallEn from './builtin/missedCall.en.json' with { type: 'json' };
import missedCallEs from './builtin/missedCall.es.json' with { type: 'json' };
import missedCallFr from './builtin/missedCall.fr.json' with { type: 'json' };
import missedCallIt from './builtin/missedCall.it.json' with { type: 'json' };
import missedCallRu from './builtin/missedCall.ru.json' with { type: 'json' };
import resetDe from './builtin/reset.de.json' with { type: 'json' };
import resetEn from './builtin/reset.en.json' with { type: 'json' };
import resetEs from './builtin/reset.es.json' with { type: 'json' };
import resetFr from './builtin/reset.fr.json' with { type: 'json' };
import resetIt from './builtin/reset.it.json' with { type: 'json' };
import resetRu from './builtin/reset.ru.json' with { type: 'json' };
import setupDe from './builtin/setup.de.json' with { type: 'json' };
import setupEn from './builtin/setup.en.json' with { type: 'json' };
import setupEs from './builtin/setup.es.json' with { type: 'json' };
import setupFr from './builtin/setup.fr.json' with { type: 'json' };
import setupIt from './builtin/setup.it.json' with { type: 'json' };
import setupRu from './builtin/setup.ru.json' with { type: 'json' };
import updateFailedDe from './builtin/updateFailed.de.json' with { type: 'json' };
import updateFailedEn from './builtin/updateFailed.en.json' with { type: 'json' };
import updateFailedEs from './builtin/updateFailed.es.json' with { type: 'json' };
import updateFailedFr from './builtin/updateFailed.fr.json' with { type: 'json' };
import updateFailedIt from './builtin/updateFailed.it.json' with { type: 'json' };
import updateFailedRu from './builtin/updateFailed.ru.json' with { type: 'json' };
import voicemailDe from './builtin/voicemail.de.json' with { type: 'json' };
import voicemailEn from './builtin/voicemail.en.json' with { type: 'json' };
import voicemailEs from './builtin/voicemail.es.json' with { type: 'json' };
import voicemailFr from './builtin/voicemail.fr.json' with { type: 'json' };
import voicemailIt from './builtin/voicemail.it.json' with { type: 'json' };
import voicemailRu from './builtin/voicemail.ru.json' with { type: 'json' };
import type { Language, TemplateKind, TemplateSource } from './templates.js';

export const BUILTIN_TEMPLATES: Record<
  `${TemplateKind}.${Language}`,
  TemplateSource
> = {
  'breakingUpdate.de': breakingUpdateDe,
  'breakingUpdate.en': breakingUpdateEn,
  'breakingUpdate.es': breakingUpdateEs,
  'breakingUpdate.fr': breakingUpdateFr,
  'breakingUpdate.it': breakingUpdateIt,
  'breakingUpdate.ru': breakingUpdateRu,
  'missedCall.de': missedCallDe,
  'missedCall.en': missedCallEn,
  'missedCall.es': missedCallEs,
  'missedCall.fr': missedCallFr,
  'missedCall.it': missedCallIt,
  'missedCall.ru': missedCallRu,
  'reset.de': resetDe,
  'reset.en': resetEn,
  'reset.es': resetEs,
  'reset.fr': resetFr,
  'reset.it': resetIt,
  'reset.ru': resetRu,
  'setup.de': setupDe,
  'setup.en': setupEn,
  'setup.es': setupEs,
  'setup.fr': setupFr,
  'setup.it': setupIt,
  'setup.ru': setupRu,
  'updateFailed.de': updateFailedDe,
  'updateFailed.en': updateFailedEn,
  'updateFailed.es': updateFailedEs,
  'updateFailed.fr': updateFailedFr,
  'updateFailed.it': updateFailedIt,
  'updateFailed.ru': updateFailedRu,
  'voicemail.de': voicemailDe,
  'voicemail.en': voicemailEn,
  'voicemail.es': voicemailEs,
  'voicemail.fr': voicemailFr,
  'voicemail.it': voicemailIt,
  'voicemail.ru': voicemailRu
};
