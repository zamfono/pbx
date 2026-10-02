/**
 * The tests' `CoreClient`: the methods a test overrides, over a real client whose every request
 * fails the way an unreachable `core`'s does, so no stub hand-copies the methods it does not use.
 */
import { createCoreClient, type CoreClient } from './coreClient.js';

export function stubCoreClient(
  overrides: Partial<CoreClient> = {}
): CoreClient {
  const unreachable = createCoreClient('http://core.test', () =>
    Promise.reject(new Error('core unreachable'))
  );
  return { ...unreachable, ...overrides };
}
