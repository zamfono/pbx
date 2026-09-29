import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { stackVersion } from './stack.js';

async function stackDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'zamfono-stack-'));
  await Promise.all(
    Object.entries(files).map(async ([name, text]) =>
      writeFile(path.join(dir, name), text)
    )
  );
  return dir;
}

const COMPOSE =
  // eslint-disable-next-line no-template-curly-in-string -- Compose's own interpolation, not a template
  'services:\n  api:\n    image: ghcr.io/zamfono/api:${ZAMFONO_VERSION:-0.0.6}\n';

describe('stackVersion', () => {
  it('reads the bundle’s pin in compose.yaml', async () => {
    const dir = await stackDir({ 'compose.yaml': COMPOSE, '.env': 'FQDN=x\n' });
    expect(await stackVersion(dir)).toEqual([0, 0, 6]);
  });

  it('prefers the ZAMFONO_VERSION .env pins', async () => {
    const dir = await stackDir({
      'compose.yaml': COMPOSE,
      '.env': "FQDN=x\nZAMFONO_VERSION='0.0.5'\n"
    });
    expect(await stackVersion(dir)).toEqual([0, 0, 5]);
  });

  it('knows none for a directory that pins none', async () => {
    const dir = await stackDir({
      // eslint-disable-next-line no-template-curly-in-string -- Compose's own interpolation
      'compose.yaml': 'image: ghcr.io/zamfono/api:${ZAMFONO_VERSION:-latest}\n'
    });
    expect(await stackVersion(dir)).toBeUndefined();
  });
});
