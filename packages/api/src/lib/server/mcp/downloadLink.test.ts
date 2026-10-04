import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { nowIso } from '@zamfono/shared';

import {
  currentRequest,
  ORIGIN,
  rpc,
  seededDeps
} from '#testing/mcp/testKit.js';

import { authenticateLink, authenticateRequest } from '../auth/bearer.js';
import { handleRest } from '../rest.js';
import type { McpDeps } from './auth.js';

async function seedVoicemail(): Promise<McpDeps> {
  const deps = await seededDeps();
  const mediaDir = await mkdtemp(path.join(os.tmpdir(), 'zamfono-link-'));
  await mkdir(path.join(mediaDir, 'voicemail'));
  await writeFile(path.join(mediaDir, 'voicemail', 'vm1.wav'), 'audio-for-vm1');
  vi.stubEnv('MEDIA_DIR', mediaDir);
  await deps.db
    .insertInto('voicemails')
    .values({
      id: 'vm1',
      mailboxUserId: 'owner',
      caller: '+491234',
      filename: 'vm1.wav',
      durationS: 10,
      read: 0,
      createdAt: nowIso()
    })
    .execute();
  return deps;
}

async function audioLink(
  deps: McpDeps,
  args: Record<string, unknown>
): Promise<{ url: string; expiresAt: string }> {
  const body = await rpc(
    deps,
    currentRequest(1, 'tools/call', {
      name: 'voicemails.audio',
      arguments: args
    })
  );
  return body.result?.structuredContent as { url: string; expiresAt: string };
}

describe('voicemails.audio over MCP (§10.5 "Audio")', () => {
  it('answers with a five-minute link to the REST endpoint, not the bytes', async () => {
    const deps = await seedVoicemail();
    const before = Date.now();
    const link = await audioLink(deps, { id: 'vm1', format: 'mp3' });
    const url = new URL(link.url);
    expect(`${url.origin}${url.pathname}`).toBe(
      `${ORIGIN}/api/v1/voicemails/vm1/audio`
    );
    expect(url.searchParams.get('format')).toBe('mp3');
    expect(url.searchParams.get('access_token')).toEqual(expect.any(String));
    const ttlMs = Date.parse(link.expiresAt) - before;
    expect(ttlMs).toBeGreaterThan(290_000);
    expect(ttlMs).toBeLessThanOrEqual(301_000);
  });

  it('opens that one path as the tool caller, and REST answers it with the file', async () => {
    const deps = await seedVoicemail();
    const url = new URL((await audioLink(deps, { id: 'vm1' })).url);
    const auth = await authenticateLink(deps, 'download', url);
    expect(auth?.actor.id).toBe('owner');
    const response = await handleRest(new Request(url), auth?.actor ?? null, {
      db: deps.db,
      requestId: 'req-1'
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/wav');
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(
      'audio-for-vm1'
    );
  });

  it('opens no other path, and is no bearer token', async () => {
    const deps = await seedVoicemail();
    const url = new URL((await audioLink(deps, { id: 'vm1' })).url);
    const token = url.searchParams.get('access_token') ?? 'missing';
    const other = new URL(url);
    other.pathname = '/api/v1/voicemails/vm2/audio';
    expect(await authenticateLink(deps, 'download', other)).toBeNull();
    const asBearer = new Request(`${ORIGIN}/api/v1/users`, {
      headers: { authorization: `Bearer ${token}` }
    });
    expect(await authenticateRequest(deps, asBearer)).toBeNull();
  });
});
