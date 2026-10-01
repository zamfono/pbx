import { describe, expect, it } from 'vitest';

import { projectFromLabels } from './docker.js';

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
