/**
 * The mockup's fidelity guarantee against the API (spec §5.4):
 * - every API operation (apiOperations.json, generated from the registry) has a mock operation of
 *   the same name, and no mock operation is invented beyond the `auth.*` sign-in mocks;
 * - every input field of every configuration operation is in the field registry, so Expert mode
 *   reaches every configurable option.
 */
import { describe, expect, it } from 'vitest';

import '#lib/api/ops/index.js';
import '#lib/fields/index.js';

import { operationNames } from '#lib/api/ops/core.js';

import apiOperations from './apiOperations.json';
import { allEntityFields } from './registry';

type ApiOperation = {
  method: string;
  path: string;
  fields: Record<string, { type: string; required: boolean; in?: string }>;
};
const api = apiOperations as Record<string, ApiOperation>;

/** Inputs that address or page rather than configure. */
const NOT_CONFIGURATION_INPUTS = new Set(['id', 'confirm', 'cursor', 'limit']);

/**
 * Writes that act rather than configure: live-call control, runtime data, pure actions, account
 * actions. Their inputs are covered by the screens that run them, not by the field registry.
 */
const ACTION_OPERATIONS = [
  /^calls\./u,
  /^voicemails\./u,
  /^recordings\./u,
  /^audit\./u,
  /^system\./u,
  /^backups\.runs\./u,
  /^sipBans\./u,
  /^users\.(resetPassword|resetMfa|erase|setPresence|setVoicemailGreeting|clearVoicemailGreeting)$/u,
  /^devices\.(revealCredentials|rotate)$/u,
  /^personalAccessTokens\.revoke$/u,
  /^trunks\.(reregister|setOrder)$/u,
  /^mailTemplates\.test$/u,
  /^provisioning\.ringotelOptions$/u
];

const isWrite = (operation: ApiOperation): boolean =>
  operation.method !== 'GET';
const isAction = (name: string): boolean =>
  ACTION_OPERATIONS.some(pattern => pattern.test(name));

describe('operations', () => {
  it('implements every API operation', () => {
    const mocked = new Set(operationNames());
    const missing = Object.keys(api).filter(name => !mocked.has(name));
    expect(missing).toEqual([]);
  });

  it('invents no operation the API lacks', () => {
    const invented = operationNames().filter(
      name => !(name in api) && !name.startsWith('auth.')
    );
    expect(invented).toEqual([]);
  });
});

describe('field registry', () => {
  const entities = allEntityFields();

  it('covers every configuration operation', () => {
    const covered = new Set(entities.flatMap(entity => entity.ops));
    const uncovered = Object.entries(api)
      .filter(([name, operation]) => isWrite(operation) && !isAction(name))
      .filter(([, operation]) =>
        Object.keys(operation.fields).some(
          field => !NOT_CONFIGURATION_INPUTS.has(field)
        )
      )
      .map(([name]) => name)
      .filter(name => !covered.has(name));
    expect(uncovered).toEqual([]);
  });

  for (const entity of entities) {
    it(`${entity.entity}: lists every input field of its operations`, () => {
      const known = new Set([
        ...entity.fields.map(field => field.key),
        ...(entity.notFields ?? []),
        ...NOT_CONFIGURATION_INPUTS
      ]);
      const missing = entity.ops.flatMap(name => {
        const operation = api[name];
        if (operation === undefined) {
          return [`${name} (no such API operation)`];
        }
        return Object.keys(operation.fields)
          .filter(field => !known.has(field))
          .map(field => `${name}: ${field}`);
      });
      expect(missing).toEqual([]);
    });

    it(`${entity.entity}: lists no field its operations lack`, () => {
      const inputs = new Set(
        entity.ops.flatMap(name => Object.keys(api[name]?.fields ?? {}))
      );
      const extra = entity.fields
        .filter(field => field.readOnly !== true && !inputs.has(field.key))
        .map(field => field.key);
      expect(extra).toEqual([]);
    });
  }
});
