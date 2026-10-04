/// <reference types="vite/client" />
import type { Language, MailKind } from '@zamfono/shared';

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
  MailKind,
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
  },
  updateFailed: {
    offered: [
      ...COMMON_PLACEHOLDERS,
      'fromVersion',
      'toVersion',
      'reason',
      'failedAt'
    ],
    required: []
  },
  breakingUpdate: {
    offered: [
      ...COMMON_PLACEHOLDERS,
      'currentVersion',
      'version',
      'releaseUrl',
      'publishedAt'
    ],
    required: []
  }
};

// The shipped templates (§10.2 "Templates"), bundled into the server at build time.
const BUILTIN_TEMPLATES = import.meta.glob<TemplateSource>('./builtin/*.json', {
  eager: true,
  import: 'default'
});

/** The shipped `builtin/<kind>.<language>.json` template (§10.2 "Templates"). */
export function loadBuiltinTemplate(
  kind: MailKind,
  language: Language
): TemplateSource {
  const source = BUILTIN_TEMPLATES[`./builtin/${kind}.${language}.json`];
  if (source === undefined) {
    throw new Error(`mail: no shipped template ${kind}.${language}`);
  }
  return source;
}
