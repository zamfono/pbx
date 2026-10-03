import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { serverInfo } from './results.js';

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
