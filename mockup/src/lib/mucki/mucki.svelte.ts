/**
 * The app's Mucki: the engine wired to the operations layer as the signed-in person over MCP
 * (`clientId` mucki, client name Mucki, so the audit log and the screens show where a change came
 * from), its histories in localStorage, cleared by *Reset demo*.
 */
// The ops index registers every area's operations.
import { confirmationFor } from '#lib/api/ops/core.js';
import { allowed, call } from '#lib/api/ops/index.js';
import { onDemoReset } from '#lib/state/demo.js';
import { currentActor, session } from '#lib/state/session.svelte.js';

import { MuckiEngine } from './engine.svelte';
import { capabilities, SCENARIOS } from './scenarios';

const CLIENT = {
  channel: 'mcp',
  clientId: 'mucki',
  clientName: 'Mucki'
} as const;

function storage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export const mucki = new MuckiEngine({
  persona: () => session.persona,
  actor: currentActor,
  call: (operation, input, confirmed) =>
    call(operation, input, { actor: currentActor(), ...CLIENT, confirmed }),
  confirmationFor: (operation, input) =>
    confirmationFor(operation, input, { actor: currentActor(), ...CLIENT }),
  allowed: (operation, input) => allowed(operation, input, currentActor()),
  scenarios: SCENARIOS,
  capabilities,
  storage: storage()
});

onDemoReset(() => mucki.clearAll());
