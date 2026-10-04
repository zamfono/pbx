import { describe, expect, it } from 'vitest';

import { BinaryResult } from '../binaryResult.js';
import { outputJsonSchema, outputMediaTypes } from './publishedOutput.js';
import { registry } from './registry.js';

import './index.js';

describe('ops/index', () => {
  // Each area's own index.ts registers on import; this guards the aggregator in ops/index.ts
  // itself, which every task must extend with its own import line (see the comment there).
  it('registers provisioning.ringotelSetup', () => {
    expect(registry.has('provisioning.ringotelSetup')).toBe(true);
  });

  // What each one answers with is checked against this schema wherever a suite runs it
  // (`publishedCheck.ts`).
  it.each([...registry.values()].map(op => [op.name, op] as const))(
    '%s declares the output it answers with, a file or JSON (§10.3)',
    (_name, op) => {
      if (outputMediaTypes(op)) {
        const file = new BinaryResult('audio/wav', 'a.wav', () =>
          Promise.resolve(Buffer.alloc(0))
        );
        expect(op.output.safeParse(file).success).toBe(true);
        return;
      }
      // Throws on what JSON Schema cannot represent, such as a `Date` or a `Buffer`.
      expect(outputJsonSchema(op)).toHaveProperty('$schema');
    }
  );
});
