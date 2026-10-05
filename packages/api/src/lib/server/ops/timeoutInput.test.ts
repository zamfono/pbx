import { expect, it } from 'vitest';

import './index.js';

import { inputJsonSchema, type JsonSchema } from './publishedSchema.js';
import { registry } from './registry.js';

// Every seconds-valued field (`…S`) of every operation's input is a timeout of at most a day, but
// the SIP ban periods, which bound a look-back rather than start a timer, at most 100 years (§11.1).
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

const SIP_BAN_PERIOD = /^settings\.update\.sipBan[A-Za-z]+S$/u;

it('bounds every seconds-valued input at 86400, a SIP ban period at 3153600000', () => {
  const fields = [...registry.values()].flatMap(op =>
    secondsFields(inputJsonSchema(op), op.name)
  );

  expect(fields.length).toBeGreaterThanOrEqual(8);
  expect(
    Object.fromEntries(fields.map(([name, field]) => [name, maximum(field)]))
  ).toEqual(
    Object.fromEntries(
      fields.map(([name]) => [
        name,
        SIP_BAN_PERIOD.test(name) ? 3_153_600_000 : 86_400
      ])
    )
  );
});
