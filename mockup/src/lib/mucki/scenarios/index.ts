/**
 * Every scenario, in tie-breaking order, and the chips that suggest them: by role, by the page the
 * person is on, and as the fallback list of what this demo covers.
 */
import type { Actor } from '#lib/api/ops/core.js';
import type { Role } from '#lib/api/types.js';
import { t } from '#lib/i18n/index.svelte.js';

import type { Scenario } from '../scenario';
import type { Chip } from '../types';
import { closure, diagnose, onboard, trunkHealth, undo } from './admin';
import { aiAgent, batch, SAMPLE_ROWS, update } from './owner';
import { forwardMobile, lastRecording, vacation } from './self';

export { SAMPLE_ROWS };

export const SCENARIOS: Scenario[] = [
  batch,
  undo,
  closure,
  diagnose,
  aiAgent,
  forwardMobile,
  vacation,
  lastRecording,
  onboard,
  trunkHealth,
  update
];

type Suggestion = {
  id: string;
  roles: Role[];
  routes: RegExp[];
  chip: () => Chip;
};

const prompt =
  (key: string): (() => Chip) =>
  () => ({ label: t(key) });

const SUGGESTIONS: Suggestion[] = [
  {
    id: 'onboard',
    roles: ['admin', 'owner'],
    routes: [/^\/users/u],
    chip: prompt('mucki.prompt.onboard')
  },
  {
    id: 'batch',
    roles: ['owner', 'admin'],
    routes: [/^\/users/u],
    chip: () => ({
      label: t('mucki.prompt.batch'),
      prompt: SAMPLE_ROWS,
      paste: true
    })
  },
  {
    id: 'closure',
    roles: ['admin', 'owner'],
    routes: [/^\/ring-groups/u, /^\/company-hours/u],
    chip: prompt('mucki.prompt.closure')
  },
  {
    id: 'undo',
    roles: ['admin', 'owner'],
    routes: [/^\/audit/u],
    chip: prompt('mucki.prompt.undo')
  },
  {
    id: 'diagnose',
    roles: ['admin', 'owner'],
    routes: [/^\/history/u, /^\/voicemail/u, /^\/live/u],
    chip: prompt('mucki.prompt.diagnose')
  },
  {
    id: 'trunk',
    roles: ['admin', 'owner'],
    routes: [/^\/trunks/u, /^\/outbound-routes/u, /^\/overview/u],
    chip: prompt('mucki.prompt.trunk')
  },
  {
    id: 'update',
    roles: ['owner'],
    routes: [/^\/system/u, /^\/backups/u, /^\/settings/u],
    chip: prompt('mucki.prompt.update')
  },
  {
    id: 'aiAgent',
    roles: ['owner', 'admin'],
    routes: [/^\/numbers/u, /^\/integrations/u, /^\/trunks/u],
    chip: prompt('mucki.prompt.aiAgent')
  },
  {
    id: 'forwardMobile',
    roles: ['user', 'admin', 'owner'],
    routes: [/^\/me/u],
    chip: prompt('mucki.prompt.forwardMobile')
  },
  {
    id: 'vacation',
    roles: ['user', 'admin', 'owner'],
    routes: [/^\/me/u],
    chip: prompt('mucki.prompt.vacation')
  },
  {
    id: 'lastRecording',
    roles: ['user'],
    routes: [/^\/calls/u, /^\/voicemail/u, /^\/recordings/u],
    chip: prompt('mucki.prompt.lastRecording')
  }
];

/** The scenarios each demo persona is introduced with, in order. */
const STARTERS: Record<Role, string[]> = {
  admin: ['onboard', 'closure', 'diagnose', 'trunk'],
  owner: ['batch', 'update', 'aiAgent', 'closure'],
  user: ['forwardMobile', 'vacation', 'lastRecording']
};

const chipOf = (id: string): Chip | null =>
  SUGGESTIONS.find(suggestion => suggestion.id === id)?.chip() ?? null;

/** The welcome chips of a role. */
export function starterChips(role: Role): Chip[] {
  return STARTERS[role]
    .map(chipOf)
    .filter((chip): chip is Chip => chip !== null);
}

/** Up to `max` chips for this page first, then the role's starters; `undo` once Mucki changed
 * something. */
export function suggestionChips(
  role: Role,
  path: string,
  options: { canUndo: boolean; max?: number }
): Chip[] {
  const max = options.max ?? 3;
  const ids: string[] = [];
  if (options.canUndo && role !== 'user') {
    ids.push('undo');
  }
  for (const suggestion of SUGGESTIONS) {
    if (
      suggestion.roles.includes(role) &&
      suggestion.routes.some(route => route.test(path))
    ) {
      ids.push(suggestion.id);
    }
  }
  ids.push(...STARTERS[role]);
  return [...new Set(ids)]
    .slice(0, max)
    .map(chipOf)
    .filter((chip): chip is Chip => chip !== null);
}

/** What this demo covers for `actor`: the fallback's chips. */
export function capabilities(actor: Actor): Chip[] {
  const ids = SUGGESTIONS.filter(suggestion =>
    suggestion.roles.includes(actor.role)
  ).map(suggestion => suggestion.id);
  return ids.map(chipOf).filter((chip): chip is Chip => chip !== null);
}
