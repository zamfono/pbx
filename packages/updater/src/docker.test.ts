import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { projectFromLabels, serviceRevision } from './docker.js';

describe('projectFromLabels', () => {
  it('reads the project and its host directory', () => {
    expect(
      projectFromLabels({
        'com.docker.compose.project': 'zamfono',
        'com.docker.compose.project.working_dir': '/srv/zamfono',
        'com.docker.compose.project.config_files':
          '/srv/zamfono/compose.yaml,/srv/zamfono/compose.ports.yaml'
      })
    ).toEqual({ name: 'zamfono', workingDir: '/srv/zamfono' });
  });

  it('refuses a container Compose did not create', () => {
    expect(() => projectFromLabels({})).toThrow('Compose project labels');
  });
});

describe('serviceRevision', () => {
  it('reads the revision label of the project service container', async () => {
    const socket = path.join(
      await mkdtemp(path.join(os.tmpdir(), 'docker-')),
      'sock'
    );
    const asked: string[] = [];
    const server = http.createServer((request, response) => {
      asked.push(decodeURIComponent(request.url ?? ''));
      response.end(
        JSON.stringify([
          { Labels: { 'org.opencontainers.image.revision': 'abc' } }
        ])
      );
    });
    await new Promise<void>(resolve => {
      server.listen(socket, resolve);
    });
    try {
      const project = { name: 'zamfono', workingDir: '/srv/zamfono' };
      expect(await serviceRevision(socket, project, 'api')).toBe('abc');
      expect(asked).toEqual([
        '/containers/json?filters={"label":["com.docker.compose.project=zamfono","com.docker.compose.service=api"]}'
      ]);
    } finally {
      server.close();
    }
  });
});
