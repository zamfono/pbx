/// <reference types="vite/client" />
import type { MailKind } from '@zamfono/shared';

import { BUILTIN_TEMPLATES } from './builtinIndex.js';

/** §10.2 "Templates": the mail kinds `api` renders, one shipped template per kind and language. */
export type TemplateKind = MailKind;

/** The six tenant languages (§9.1, §10.2, §11.2). */
export type Language = 'de' | 'en' | 'es' | 'fr' | 'it' | 'ru';

/** A shipped or tenant-authored template row before compilation (§11.2 `mail_templates`). */
export type TemplateSource = {
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
};

// Offered on every kind (§10.2 table): the company display name, the addressee's name and the
// stack's public hostname.
const COMMON_PLACEHOLDERS = ['companyName', 'recipientName', 'fqdn'];

/** §10.2 table: the placeholders each kind offers, and which of those a template must use. */
export const PLACEHOLDERS: Record<
  TemplateKind,
  { offered: string[]; required: string[] }
> = {
  voicemail: {
    offered: [
      ...COMMON_PLACEHOLDERS,
      'callerNumber',
      'callerName',
      'mailboxName',
      'receivedAt',
      'durationS'
    ],
    required: []
  },
  missedCall: {
    offered: [
      ...COMMON_PLACEHOLDERS,
      'callerNumber',
      'callerName',
      'receivedAt',
      'didLabel'
    ],
    required: []
  },
  setup: {
    offered: [...COMMON_PLACEHOLDERS, 'link', 'linkExpiresAt', 'invitedBy'],
    required: ['link']
  },
  reset: {
    offered: [...COMMON_PLACEHOLDERS, 'link', 'linkExpiresAt'],
    required: ['link']
  }
};

/** The shipped `builtin/<kind>.<language>.json` template (§10.2 "Templates"). */
export function loadBuiltinTemplate(
  kind: TemplateKind,
  language: Language
): TemplateSource {
  return BUILTIN_TEMPLATES[`${kind}.${language}`];
}
