import { expect, it } from 'vitest';

import './index.js';

import { inputJsonSchema, type JsonSchema } from './publishedSchema.js';
import { registry } from './registry.js';

// Every seconds-valued field (`…S`) of every operation's input is a timeout of at most a day.
function secondsFields(schema: JsonSchema, at: string): [string, JsonSchema][] {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const branches = [
    ...((schema.anyOf ?? schema.oneOf ?? []) as JsonSchema[]),
    ...(schema.items ? [schema.items as JsonSchema] : [])
  ];
  return [
    ...Object.entries(properties).flatMap(([name, field]) => [
      ...(/[a-z]S$/u.test(name)
        ? [[`${at}.${name}`, field] as [string, JsonSchema]]
        : []),
      ...secondsFields(field, `${at}.${name}`)
    ]),
    ...branches.flatMap(branch => secondsFields(branch, at))
  ];
}

/** `field`'s `maximum`, through the `anyOf` a nullable field has. */
function maximum(field: JsonSchema): unknown {
  const branches = (field.anyOf ?? []) as JsonSchema[];
  return field.maximum ?? branches.find(branch => 'maximum' in branch)?.maximum;
}

it('bounds every seconds-valued input at 86400', () => {
  const fields = [...registry.values()].flatMap(op =>
    secondsFields(inputJsonSchema(op), op.name)
  );

  expect(fields.length).toBeGreaterThanOrEqual(8);
  expect(
    Object.fromEntries(fields.map(([name, field]) => [name, maximum(field)]))
  ).toEqual(Object.fromEntries(fields.map(([name]) => [name, 86_400])));
});
