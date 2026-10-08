/**
 * Condenses the OpenAPI snapshot into what the field-completeness test needs: every operation's
 * input fields (request-body properties and query/path parameters) with type, enum, required and
 * the API's own description, keyed by operation name.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

const [, , snapshotPath, outPath] = process.argv;
const document = JSON.parse(readFileSync(snapshotPath, 'utf8'));

const resolve = schema =>
  schema?.$ref === undefined
    ? schema
    : schema.$ref
        .replace('#/', '')
        .split('/')
        .reduce((node, key) => node[key], document);

const describeType = schema => {
  const resolved = resolve(schema) ?? {};
  if (resolved.anyOf || resolved.oneOf) {
    return (resolved.anyOf ?? resolved.oneOf).map(describeType).join('|');
  }
  return [resolved.type].flat().filter(Boolean).join('|') || 'object';
};

const fieldsOf = schema => {
  const resolved = resolve(schema) ?? {};
  const required = new Set(resolved.required ?? []);
  return Object.fromEntries(
    Object.entries(resolved.properties ?? {}).map(([name, property]) => {
      const prop = resolve(property);
      return [
        name,
        {
          type: describeType(prop),
          ...(prop.enum ? { enum: prop.enum } : {}),
          required: required.has(name),
          description: prop.description ?? null
        }
      ];
    })
  );
};

const operations = {};
for (const [path, methods] of Object.entries(document.paths)) {
  for (const [method, operation] of Object.entries(methods)) {
    const name = operation['x-operation-name'] ?? operation.operationId;
    const body =
      operation.requestBody?.content?.['application/json']?.schema ??
      operation.requestBody?.content?.['multipart/form-data']?.schema;
    const parameters = Object.fromEntries(
      (operation.parameters ?? []).map(parameter => [
        parameter.name,
        {
          type: describeType(parameter.schema),
          ...(resolve(parameter.schema)?.enum
            ? { enum: resolve(parameter.schema).enum }
            : {}),
          required: parameter.required === true,
          in: parameter.in,
          description: parameter.description ?? null
        }
      ])
    );
    operations[name] = {
      method: method.toUpperCase(),
      path,
      summary: operation.summary ?? null,
      fields: { ...parameters, ...fieldsOf(body) }
    };
  }
}

writeFileSync(outPath, `${JSON.stringify(operations, null, 2)}\n`);
rmSync(snapshotPath);
