import { describe, expect, it } from 'vitest';

import { variables } from './env.js';

type Name = keyof typeof variables;

/** The value `src/env.ts` hands `$app/env/private` for `raw`, as SvelteKit applies it at start. */
function read(name: Name, raw: string | undefined): unknown {
  const result = variables[name].schema['~standard'].validate(raw);
  if (result instanceof Promise) {
    throw new TypeError(`${name}: asynchronous schema`);
  }
  if (result.issues !== undefined) {
    throw new Error(`${name}: ${result.issues[0]?.message ?? 'invalid'}`);
  }
  return result.value;
}

// §6.3 "Environment": Compose hands an unset `${VAR:-}` over as the empty string.
describe('src/env.ts', () => {
  it('reads an empty optional value as unset', () => {
    expect(read('SECRETBOX_KEY_PREVIOUS', '')).toBeUndefined();
    expect(read('SMTP_HOST', '')).toBeUndefined();
    expect(read('SMTP_HOST', 'smtp.example.com')).toBe('smtp.example.com');
  });

  it('takes the default of an unset or empty internal value', () => {
    expect(read('DB_FILE', undefined)).toBe('/data/zamfono.sqlite3');
    expect(read('MEDIA_DIR', '')).toBe('/media');
    expect(read('CORE_URL', undefined)).toBe('http://core:3000');
    expect(read('DB_FILE', '/tmp/x.sqlite3')).toBe('/tmp/x.sqlite3');
  });

  it('refuses an unset or empty required value', () => {
    expect(() => read('FQDN', '')).toThrow('Value is missing or empty.');
    expect(() => read('JWT_SECRET', undefined)).toThrow();
  });

  it('reads FQDN in lower case, the form Caddy names its certificate by', () => {
    expect(read('FQDN', 'Pbx.Example.com')).toBe('pbx.example.com');
  });

  it('turns a switch off only for the literal false', () => {
    expect(read('HEP_ENABLED', 'false')).toBe(false);
    expect(read('HEP_ENABLED', '')).toBe(true);
    expect(read('SIP_UDP_ENABLED', undefined)).toBe(true);
  });

  it('reads TLS_RELOAD_HOUR as an hour, anything else as unset', () => {
    expect(read('TLS_RELOAD_HOUR', '0')).toBe(0);
    expect(read('TLS_RELOAD_HOUR', '23')).toBe(23);
    expect(read('TLS_RELOAD_HOUR', '')).toBeUndefined();
    expect(read('TLS_RELOAD_HOUR', '24')).toBeUndefined();
    expect(read('TLS_RELOAD_HOUR', 'x')).toBeUndefined();
  });
});
