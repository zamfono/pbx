import { describe, expect, it, vi } from 'vitest';

import { epochSeconds, newId } from '@zamfono/shared';
import { seedUser } from '@zamfono/shared/testDb.js';

import {
  CLIENT_ID,
  currentHeaders,
  currentMeta,
  currentRequest,
  JWT_SECRET,
  mcpRequest,
  ORIGIN,
  rpc,
  seededDeps
} from '#testing/mcp/testKit.js';
import { seedSession } from '#testing/testDb.js';

import { authenticateLink } from '../auth/bearer.js';
import { signAccessToken } from '../auth/jwt.js';
import { runUploadLink } from '../uploadLink.js';
import type { McpDeps } from './auth.js';

vi.mock('#lib/server/audio/store.js', () => ({
  storeAudio: vi.fn(async (kind: string, upload: { filename: string }) =>
    Promise.resolve({ id: newId(), filename: `${kind}-${upload.filename}.wav` })
  ),
  deleteAudioFile: vi.fn(async () => Promise.resolve())
}));

const file = {
  filename: 'hold.wav',
  mimeType: 'audio/wav',
  data: Buffer.from('x')
};

type ToolBody = {
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

async function callTool(
  deps: McpDeps,
  name: string,
  args: Record<string, unknown>
): Promise<ToolBody> {
  const body = await rpc(
    deps,
    currentRequest(1, 'tools/call', { name, arguments: args })
  );
  return body.result as ToolBody;
}

async function linkFor(
  deps: McpDeps,
  name: string,
  args: Record<string, unknown>
): Promise<URL> {
  const result = await callTool(deps, name, args);
  return new URL(String(result.structuredContent?.url));
}

describe('upload tools over MCP (§10.5 "Uploads")', () => {
  it('answer with a five-minute upload link carrying the metadata', async () => {
    const deps = await seededDeps();
    const before = Date.now();
    const result = await callTool(deps, 'audio.create', {
      kind: 'moh',
      label: 'Hold'
    });
    const link = result.structuredContent as { url: string; expiresAt: string };
    const url = new URL(link.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${ORIGIN}/upload/audio`);
    expect(url.searchParams.get('kind')).toBe('moh');
    expect(url.searchParams.get('label')).toBe('Hold');
    const ttlMs = Date.parse(link.expiresAt) - before;
    expect(ttlMs).toBeGreaterThan(290_000);
    expect(ttlMs).toBeLessThanOrEqual(301_000);
  });

  it('refuse metadata that is invalid before the file, with no link', async () => {
    const deps = await seededDeps();
    const result = await callTool(deps, 'audio.create', {
      kind: 'jingle',
      label: 'Hold'
    });
    expect(result.isError).toBe(true);
  });

  it('run the operation once the file is posted to the link, audited as the tool caller', async () => {
    const deps = await seededDeps();
    const url = await linkFor(deps, 'audio.create', {
      kind: 'moh',
      label: 'Hold'
    });
    const asset = (await runUploadLink(deps, url, () =>
      Promise.resolve({ upload: file })
    )) as {
      id: string;
      kind: string;
      label: string;
    };
    expect(asset).toMatchObject({ kind: 'moh', label: 'Hold' });
    const audit = await deps.db
      .selectFrom('auditLog')
      .select(['channel', 'clientId'])
      .where('operation', '=', 'audio.create')
      .executeTakeFirstOrThrow();
    expect(audit).toEqual({ channel: 'mcp', clientId: CLIENT_ID });
  });

  it('link a path operation under its own path', async () => {
    const deps = await seededDeps();
    const url = await linkFor(deps, 'users.setVoicemailGreeting', {
      id: 'owner'
    });
    expect(url.pathname).toBe('/upload/users/owner/voicemailGreeting');
    expect(url.searchParams.has('id')).toBe(false);
  });

  it('open no other upload and no REST path', async () => {
    const deps = await seededDeps();
    const url = await linkFor(deps, 'audio.create', {
      kind: 'moh',
      label: 'Hold'
    });
    const other = new URL(url);
    other.pathname = '/upload/users/owner/voicemailGreeting';
    await expect(
      runUploadLink(deps, other, () => Promise.resolve({ upload: file }))
    ).rejects.toMatchObject({ status: 401 });
    const rest = new URL(url);
    rest.pathname = '/api/v1/audio';
    expect(await authenticateLink(deps, 'download', rest)).toBeNull();
  });

  it("refuse a user a link to another user's upload, as the run would (§5.3)", async () => {
    const deps = await seededDeps();
    await seedUser(deps.db, {
      id: 'user-1',
      name: 'User',
      email: 'user@x',
      role: 'user',
      passwordHash: 'x'
    });
    await seedSession(deps.db, 'user-1', CLIENT_ID, 'session-2');
    const token = await signAccessToken(
      JWT_SECRET,
      { sub: 'user-1', role: 'user', cid: CLIENT_ID, sid: 'session-2' },
      epochSeconds(Date.now()),
      ORIGIN
    );
    const params = {
      name: 'users.setVoicemailGreeting',
      arguments: { id: 'owner' }
    };
    const body = await rpc(
      deps,
      mcpRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { ...params, _meta: currentMeta() }
        },
        currentHeaders('tools/call', params),
        token
      )
    );
    expect(body.result).toMatchObject({
      isError: true,
      structuredContent: { status: 403 }
    });
  });
});
