import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { serverInfo } from './results.js';

const STATIC_DIR = new URL('../../../static/', import.meta.url);

describe('serverInfo', () => {
  it('names the stack, and has no icons without ORIGIN', () => {
    expect(serverInfo({})).toEqual({
      name: 'zamfono',
      title: 'Zamfono',
      version: expect.any(String) as string,
      websiteUrl: 'https://github.com/zamfono/pbx'
    });
  });

  it("points each icon at the stack's own origin, light and dark", () => {
    const { icons } = serverInfo({ ORIGIN: 'https://pbx.example/' });
    expect(icons).toEqual([
      {
        src: 'https://pbx.example/logo.svg',
        mimeType: 'image/svg+xml',
        sizes: ['any'],
        theme: 'light'
      },
      {
        src: 'https://pbx.example/logoDark.svg',
        mimeType: 'image/svg+xml',
        sizes: ['any'],
        theme: 'dark'
      },
      {
        src: 'https://pbx.example/logo.png',
        mimeType: 'image/png',
        sizes: ['192x192'],
        theme: 'light'
      },
      {
        src: 'https://pbx.example/logoDark.png',
        mimeType: 'image/png',
        sizes: ['192x192'],
        theme: 'dark'
      }
    ]);
  });

  it('names only files the stack serves from static/', () => {
    const { icons } = serverInfo({ ORIGIN: 'https://pbx.example' }) as {
      icons: { src: string }[];
    };
    for (const { src } of icons) {
      expect(existsSync(new URL(`.${new URL(src).pathname}`, STATIC_DIR))).toBe(
        true
      );
    }
  });
});
