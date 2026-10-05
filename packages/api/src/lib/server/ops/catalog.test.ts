import { describe, expect, it } from 'vitest';

import { API_PREFIX, routes } from '../restRoutes.js';
import { catalogLines } from './catalog.js';
import { registry } from './registry.js';

describe('catalogLines', () => {
  it('lists every registered operation once, as a header plus one row each', () => {
    const lines = catalogLines();
    const [header, separator, ...rows] = lines;
    expect(header).toBe(
      '| Operation (MCP tool) | REST | Description | Min role | Confirm |'
    );
    expect(separator).toBe('| --- | --- | --- | --- | --- |');
    expect(rows).toHaveLength(registry.size);
  });

  it('has actually loaded the registry, so an empty catalog cannot pass silently', () => {
    // Every other assertion in this file is relative to `registry`, so a lost side-effect
    // import (or an area that forgot to register itself) would still pass them at size 0. These
    // two assertions are the ones that fail in that case.
    expect(registry.size).toBeGreaterThan(0);
    expect(registry.has('users.create')).toBe(true);
    expect(catalogLines()).toContain(
      '| `users.create` | `POST /api/v1/users` | Creates a user, assigns their extension and returns a setup link. | admin | no |'
    );
  });

  it('sorts rows by operation name in code-point order', () => {
    const [, , ...rows] = catalogLines();
    const names = rows.map(
      row => /^\| `(?<name>[^`]+)`/u.exec(row)?.groups?.name
    );
    expect(names).toEqual([...names].sort());
  });

  it('carries each operation’s REST endpoints, description, min role and confirm flag', () => {
    const lines = catalogLines();
    for (const op of registry.values()) {
      const row = lines.find(line => line.startsWith(`| \`${op.name}\` |`));
      const endpoints = routes
        .filter(route => route.op === op.name)
        .map(route => `\`${route.method} ${API_PREFIX}${route.pattern}\``);
      const rest = endpoints.length === 0 ? '—' : endpoints.join(', ');
      expect(row).toBe(
        `| \`${op.name}\` | ${rest} | ${op.description} | ${op.minRole} | ${op.confirm ? 'yes' : 'no'} |`
      );
    }
  });

  it('names every scoped route of an operation that has several', () => {
    const row = catalogLines().find(line => line.startsWith('| `ooo.list` |'));
    expect(row).toContain('`GET /api/v1/users/{id}/ooo`');
    expect(row).toContain('`GET /api/v1/tenant/ooo`');
  });
});
