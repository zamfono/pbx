import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { HTTP_CONFLICT } from '@zamfono/shared';

import { OpError } from '../ops/types.js';
import { MAX_BODY_BYTES } from '../requestBody.js';
import { serverInfo, toolErrorResult } from './results.js';

const STATIC_DIR = new URL('../../../../static/', import.meta.url);

describe('serverInfo', () => {
  it('names the stack', () => {
    expect(serverInfo()).toMatchObject({
      name: 'zamfono',
      title: 'Zamfono',
      version: expect.any(String) as string,
      websiteUrl: 'https://github.com/zamfono/pbx'
    });
  });

  it("points each icon at the stack's own origin, light and dark", () => {
    const { icons } = serverInfo();
    expect(icons).toEqual([
      {
        src: 'https://pbx.test/logo.svg',
        mimeType: 'image/svg+xml',
        sizes: ['any'],
        theme: 'light'
      },
      {
        src: 'https://pbx.test/logoDark.svg',
        mimeType: 'image/svg+xml',
        sizes: ['any'],
        theme: 'dark'
      },
      {
        src: 'https://pbx.test/logo.png',
        mimeType: 'image/png',
        sizes: ['192x192'],
        theme: 'light'
      },
      {
        src: 'https://pbx.test/logoDark.png',
        mimeType: 'image/png',
        sizes: ['192x192'],
        theme: 'dark'
      }
    ]);
  });

  it('names only files the stack serves from static/', () => {
    const { icons } = serverInfo() as {
      icons: { src: string }[];
    };
    for (const { src } of icons) {
      expect(existsSync(new URL(`.${new URL(src).pathname}`, STATIC_DIR))).toBe(
        true
      );
    }
  });
});

describe('toolErrorResult', () => {
  const issue = (index: number) => ({
    code: 'invalid_type',
    path: ['trunkIds', index],
    message: 'Invalid input: expected string, received number'
  });

  it('carries every issue of a short list', () => {
    const result = toolErrorResult(
      new OpError(HTTP_CONFLICT, 'cannot take this change back', [
        issue(0),
        issue(1)
      ])
    );
    expect(result.structuredContent).toEqual({
      status: HTTP_CONFLICT,
      title: 'cannot take this change back',
      errors: [issue(0), issue(1)]
    });
  });

  it('stays within the body limit, text block and JSON-RPC escaping included', () => {
    const issueCount = 170_000;
    const issues = Array.from({ length: issueCount }, (_unused, index) =>
      issue(index)
    );
    const result = toolErrorResult(
      new OpError(HTTP_CONFLICT, 'cannot take this change back', issues)
    );
    const response = JSON.stringify({ jsonrpc: '2.0', id: 1, result });
    expect(Buffer.byteLength(response)).toBeLessThanOrEqual(MAX_BODY_BYTES);
    const structured = result.structuredContent as {
      errors: unknown[];
      errorsOmitted: number;
    };
    expect(structured.errors).toEqual(
      issues.slice(0, structured.errors.length)
    );
    expect(structured.errors.length + structured.errorsOmitted).toBe(
      issueCount
    );
  });
});
