/**
 * The environment variables `api` reads through `$app/env/private` (§10). One published image
 * serves every stack, so each is read from the container's environment when the server starts,
 * never inlined at build time. SvelteKit validates them on every start and refuses to start while
 * a `required` one is missing or empty, naming each; Compose hands an unset `${VAR}` over as the
 * empty string. A variable with a default, a conditional requirement (the first-boot seed) or a
 * feature it turns off is `optional`, and the code reading it decides what its absence means.
 * The build's route analysis starts the server too, with `.env.production`'s placeholders.
 */
import { defineEnvVars } from '@sveltejs/kit/env';

const optional = { schema: (value: string | undefined) => value };

const required = {
  schema: (value: string | undefined): string => {
    if (!value) {
      throw new Error('Value is missing or empty.');
    }
    return value;
  }
};

export const variables = defineEnvVars({
  ASTERISK_GEN_DIR: required,
  BACKUP_PASSWORD: optional,
  BOOTSTRAP_OWNER_EMAIL: optional,
  BOOTSTRAP_OWNER_NAME: optional,
  BOOTSTRAP_OWNER_PASSWORD_HASH: optional,
  CADDY_DATA_DIR: optional,
  COMPANY_NAME: optional,
  CORE_URL: required,
  COUNTRY: optional,
  DB_FILE: required,
  EXT_LENGTH: optional,
  EXTERNAL_IPV4: optional,
  FQDN: required,
  HEP_ENABLED: optional,
  JWT_SECRET: required,
  MAIL_FROM: optional,
  MAIN_DID: optional,
  MEDIA_DIR: required,
  METRICS_TOKEN: optional,
  MIGRATIONS_DIR: required,
  MOH_SOURCE_DIR: optional,
  SECRETBOX_KEY: required,
  SECRETBOX_KEY_PREVIOUS: optional,
  SIP_TCP_ENABLED: optional,
  SIP_UDP_ENABLED: optional,
  SMTP_HOST: optional,
  SMTP_PASSWORD: optional,
  SMTP_PORT: optional,
  SMTP_SECURITY: optional,
  SMTP_USER: optional,
  STACK_IPV4: optional,
  TLS_RELOAD_HOUR: optional,
  TZ: optional,
  UPDATER_TOKEN: optional,
  UPDATER_URL: optional,
  ZAMFONO_REVISION: optional,
  ZAMFONO_VERSION: optional
});
