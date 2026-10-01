import { describe, expect, it } from 'vitest';

import { listTools } from './mcp/tools.js';
import { buildOpenApiDocument } from './openapi.js';
// The real registry, as `tools/list` and `/api/v1/openapi.json` serve it.
import './ops/index.js';

type Schema = Record<string, unknown> & {
  properties?: Record<string, Schema>;
  oneOf?: Schema[];
};

/**
 * An operation's zod `.describe()` is all an MCP client learns of a field beyond its name and
 * type (§10.5), and a REST client reading the OpenAPI document no more (§10.3): both publish the
 * same exported schema, so a description that reaches one but not the other, or neither, fails
 * here.
 */
function toolProperties(name: string): Record<string, Schema> {
  const tool = listTools().find(candidate => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`fieldDescriptions test: no tool ${name}`);
  }
  return (tool.inputSchema as Schema).properties ?? {};
}

function bodyProperties(
  pattern: string,
  method: string
): Record<string, Schema> {
  const operation = buildOpenApiDocument().paths[pattern]?.[method];
  const schema = operation?.requestBody?.content['application/json']?.schema;
  if (schema === undefined) {
    throw new Error(`fieldDescriptions test: no body for ${method} ${pattern}`);
  }
  return (schema as Schema).properties ?? {};
}

const DESCRIBED = expect.stringMatching(/\S/u) as string;

describe('field descriptions reach tools/list and the OpenAPI document', () => {
  it.each([
    [
      'didBlocks.create',
      '/didBlocks',
      'post',
      ['base', 'digits', 'fallbackTarget']
    ],
    [
      'didBlocks.update',
      '/didBlocks/{id}',
      'patch',
      ['digits', 'fallbackTarget']
    ],
    ['dids.create', '/dids', 'post', ['number', 'target']]
  ])('%s describes its fields', (tool, pattern, method, fields) => {
    const fromTools = toolProperties(tool);
    const fromOpenApi = bodyProperties(pattern, method);
    for (const field of fields) {
      expect(fromTools[field]?.description, `${tool} ${field}`).toEqual(
        DESCRIBED
      );
      expect(fromOpenApi[field]?.description, `${pattern} ${field}`).toBe(
        fromTools[field]?.description
      );
    }
  });

  it('describes each forward-target kind inside a target', () => {
    const variants = toolProperties('dids.create').target?.oneOf ?? [];
    expect(variants).toHaveLength(8);
    for (const variant of variants) {
      expect(variant.properties?.kind?.description).toEqual(DESCRIBED);
    }
  });
});
