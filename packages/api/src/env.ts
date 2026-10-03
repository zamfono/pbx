/**
 * The environment variables `api` reads through `$app/env/private` (§10). One published image
 * serves every stack, so each is read from the container's environment when the server starts,
 * never inlined at build time. SvelteKit validates them on every start and refuses to start while
 * a `required` one is missing or empty, naming each. Only what the operator alone can give is
 * required: `FQDN` and the secrets. Every other variable is read here once into the value its
 * readers use: an empty value, which Compose hands over for an unset `${VAR:-}`, counts as unset,
 * and a variable with a default takes it here. A conditional requirement (the first-boot seed) is
 * its reader's to check. The build's route analysis starts the server too, with
 * `.env.production`'s placeholders.
 */
import { defineEnvVars } from '@sveltejs/kit/env';

import { DEFAULT_DB_FILE, DEFAULT_MEDIA_DIR } from '@zamfono/shared';

const MAX_HOUR = 23;

/** The value, `undefined` while unset or empty. */
function unsetIfEmpty(value: string | undefined): string | undefined {
  return value === '' ? undefined : value;
}

const optional = { schema: unsetIfEmpty };

const required = {
  schema: (value: string | undefined): string => {
    if (!value) {
      throw new Error('Value is missing or empty.');
    }
    return value;
  }
};

/** The value, `fallback` while unset or empty. */
function withDefault(fallback: string) {
  return {
    schema: (value: string | undefined): string =>
      unsetIfEmpty(value) ?? fallback
  };
}

/** A switch that is on unless the value is the literal `false` (§7, §9.1). */
const onUnlessFalse = {
  schema: (value: string | undefined): boolean => value !== 'false'
};

/** `TLS_RELOAD_HOUR` (§6.4 "Reload timing"): an hour 0-23, `undefined` while unset or not one. */
const reloadHour = {
  schema: (value: string | undefined): number | undefined => {
    if (unsetIfEmpty(value) === undefined) {
      return undefined;
    }
    const hour = Number(value);
    return Number.isInteger(hour) && hour >= 0 && hour <= MAX_HOUR
      ? hour
      : undefined;
  }
};

export const variables = defineEnvVars({
  ASTERISK_GEN_DIR: withDefault('/etc/asterisk/gen'),
  BACKUP_PASSWORD: optional,
  BOOTSTRAP_OWNER_EMAIL: optional,
  BOOTSTRAP_OWNER_NAME: optional,
  BOOTSTRAP_OWNER_PASSWORD_HASH: optional,
  CADDY_DATA_DIR: withDefault('/caddy-data'),
  COMPANY_NAME: optional,
  CORE_URL: withDefault('http://core:3000'),
  COUNTRY: optional,
  DB_FILE: withDefault(DEFAULT_DB_FILE),
  EXT_LENGTH: optional,
  EXTERNAL_IPV4: optional,
  FQDN: required,
  HEP_ENABLED: onUnlessFalse,
  JWT_SECRET: required,
  MAIL_FROM: optional,
  MAIN_DID: optional,
  MEDIA_DIR: withDefault(DEFAULT_MEDIA_DIR),
  METRICS_TOKEN: optional,
  MIGRATIONS_DIR: withDefault('/app/db/migrations'),
  MOH_SOURCE_DIR: withDefault('/usr/share/asterisk/moh'),
  SECRETBOX_KEY: required,
  SECRETBOX_KEY_PREVIOUS: optional,
  SIP_TCP_ENABLED: onUnlessFalse,
  SIP_UDP_ENABLED: onUnlessFalse,
  SMTP_HOST: optional,
  SMTP_PASSWORD: optional,
  SMTP_PORT: optional,
  SMTP_SECURITY: optional,
  SMTP_USER: optional,
  STACK_IPV4: optional,
  TLS_RELOAD_HOUR: reloadHour,
  TZ: optional,
  UPDATER_TOKEN: optional,
  UPDATER_URL: withDefault('http://updater:8080'),
  ZAMFONO_REVISION: optional,
  ZAMFONO_VERSION: optional
});
