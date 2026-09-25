import { describe, expect, it } from 'vitest';

import { resolveVersion } from './version.js';

describe('resolveVersion', () => {
  it('falls back to dev with no parenthesis when neither variable is set, a local dev run', () => {
    expect(resolveVersion({})).toEqual({
      version: 'dev',
      revision: '',
      display: 'dev'
    });
  });

  it('reports a release tag with its short revision', () => {
    expect(
      resolveVersion({
        ZAMFONO_VERSION: '1.2.3',
        ZAMFONO_REVISION: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'
      })
    ).toEqual({
      version: '1.2.3',
      revision: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
      display: '1.2.3 (a1b2c3d)'
    });
  });

  it("reports main's latest build as edge", () => {
    expect(
      resolveVersion({
        ZAMFONO_VERSION: 'edge',
        ZAMFONO_REVISION: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'
      })
    ).toEqual({
      version: 'edge',
      revision: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
      display: 'edge (a1b2c3d)'
    });
  });

  it("omits the parenthesis with a version but no revision, Compose's own default", () => {
    expect(resolveVersion({ ZAMFONO_VERSION: 'latest' })).toEqual({
      version: 'latest',
      revision: '',
      display: 'latest'
    });
  });

  it('treats an empty string the same as unset, for both variables', () => {
    expect(
      resolveVersion({ ZAMFONO_VERSION: '', ZAMFONO_REVISION: '' })
    ).toEqual({
      version: 'dev',
      revision: '',
      display: 'dev'
    });
  });
});
