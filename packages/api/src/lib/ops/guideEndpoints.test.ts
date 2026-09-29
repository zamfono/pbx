import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { routes } from '../restRoutes.js';

/**
 * The admin guide (`docs/guide`, served by `zamfono.help` and copied into the skill) names each
 * step by its operation, which is the MCP tool's name (§10.5), with the REST call in parentheses:
 * `` `users.create` (`POST /users`) ``. A REST call the route table does not have, or one named
 * without its operation, or with another operation's, fails here, so an MCP client reading the
 * guide always learns which tool to call.
 */
const GUIDE_DIR = path.resolve(
  import.meta.dirname,
  '../../../../../docs/guide'
);

/** Endpoints the guide may name that are not operations: the health check lives outside `/api/v1`. */
const NOT_OPERATIONS = new Set(['GET /healthz']);

const REFERENCE =
  /(?:`(?<op>[\w.]+)` \()?`(?<method>GET|POST|PATCH|PUT|DELETE) (?<path>\/[^`?\s]*)(?:\?[^`]*)?`/gu;

function guideFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return guideFiles(full);
    }
    return entry.name.endsWith('.md') ? [full] : [];
  });
}

type Reference = { file: string; op?: string; endpoint: string };

function references(): Reference[] {
  return guideFiles(GUIDE_DIR).flatMap(file => {
    // Line breaks inside a paragraph are only wrapping, so an operation at a line's end still
    // pairs with the call that opens the next line.
    const text = readFileSync(file, 'utf8').replace(/\s+/gu, ' ');
    return [...text.matchAll(REFERENCE)].map(match => ({
      file: path.relative(GUIDE_DIR, file),
      op: match.groups?.op,
      endpoint: `${match.groups?.method} ${match.groups?.path}`
    }));
  });
}

describe('the admin guide’s REST references', () => {
  const found = references();

  it('finds references at all, so a broken pattern cannot pass silently', () => {
    expect(found.length).toBeGreaterThan(20);
  });

  it('names only endpoints the route table has, each after its own operation', () => {
    const wrong = found.flatMap(({ file, op, endpoint }) => {
      if (NOT_OPERATIONS.has(endpoint)) {
        return [];
      }
      const route = routes.find(
        candidate => `${candidate.method} ${candidate.pattern}` === endpoint
      );
      if (route === undefined) {
        return [`${file}: ${endpoint} is not a REST route`];
      }
      return op === route.op
        ? []
        : [
            `${file}: ${endpoint} should follow \`${route.op}\` (found ${op ?? 'none'})`
          ];
    });
    expect(wrong).toEqual([]);
  });
});
