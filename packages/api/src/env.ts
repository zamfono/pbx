/**
 * The environment variables `api` reads through `$app/env/private` (§10). One published image
 * serves every stack, so each is read from the container's environment when the server starts,
 * never inlined at build time. None is required here: the code reading a variable decides what
 * its absence means (a default, a boot-time error, a feature left off), as it does for every
 * caller outside SvelteKit's bundle.
 */
import { defineEnvVars } from '@sveltejs/kit/env';

const optional = { schema: (value: string | undefined) => value };

export const variables = defineEnvVars({
  ASTERISK_GEN_DIR: optional,
  BACKUP_PASSWORD: optional,
  BOOTSTRAP_OWNER_EMAIL: optional,
  BOOTSTRAP_OWNER_NAME: optional,
  BOOTSTRAP_OWNER_PASSWORD_HASH: optional,
  CADDY_DATA_DIR: optional,
  COMPANY_NAME: optional,
  CORE_URL: optional,
  COUNTRY: optional,
  DB_FILE: optional,
  EXT_LENGTH: optional,
  EXTERNAL_IPV4: optional,
  FQDN: optional,
  HEP_ENABLED: optional,
  JWT_SECRET: optional,
  MAIL_FROM: optional,
  MAIN_DID: optional,
  MEDIA_DIR: optional,
  METRICS_TOKEN: optional,
  MOH_SOURCE_DIR: optional,
  SECRETBOX_KEY: optional,
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
