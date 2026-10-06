import type { Language } from '@zamfono/shared';

import de from './de.json' with { type: 'json' };
import en from './en.json' with { type: 'json' };
import es from './es.json' with { type: 'json' };
import fr from './fr.json' with { type: 'json' };
import it from './it.json' with { type: 'json' };
import ru from './ru.json' with { type: 'json' };

/** One dictionary section per page `api` serves: the authentication pages (§5.2 "Authentication
 *  pages" table) and the upload page (§10.5 "Uploads"). */
export type Dictionary = {
  login: {
    title: string;
    consentIntro: string;
    consentApprove: string;
    consentDeny: string;
    email: string;
    password: string;
    submit: string;
    invalid: string;
    forgotLink: string;
    ssoPrefix: string;
  };
  /** The second step of a password sign-in (§5.2 "Two-factor authentication"). */
  mfa: {
    verifyIntro: string;
    code: string;
    verifySubmit: string;
    invalidCode: string;
    enrolIntro: string;
    qrLabel: string;
    secretLabel: string;
    enrolSubmit: string;
    codesIntro: string;
    copy: string;
    copied: string;
    download: string;
    saved: string;
    continue: string;
    usePasskey: string;
    passkeyFailed: string;
    passkeyDefaultName: string;
    passkeyOr: string;
    passkeyName: string;
    addPasskey: string;
  };
  /** The security page, where a person manages their own second factors (§5.2). */
  security: {
    title: string;
    signInIntro: string;
    signedInAs: string;
    required: string;
    totp: string;
    totpOn: string;
    totpOff: string;
    totpStart: string;
    totpReplace: string;
    totpRemove: string;
    totpConfirm: string;
    passkeys: string;
    noPasskeys: string;
    lastUsed: string;
    neverUsed: string;
    remove: string;
    recoveryCodes: string;
    codesLeft: string;
    regenerate: string;
    codesNeedMethod: string;
    lastMethod: string;
    landingLink: string;
  };
  forgot: {
    title: string;
    intro: string;
    email: string;
    submit: string;
    sent: string;
    backToLogin: string;
  };
  setPassword: {
    title: string;
    password: string;
    submit: string;
    success: string;
    successLoginLink: string;
    invalid: string;
    tooShort: string;
  };
  error: {
    title: string;
    expired: string;
    noUser: string;
    noPassword: string;
    domain: string;
    unverifiedEmail: string;
    issuer: string;
    audience: string;
    signature: string;
    nonce: string;
    generic: string;
    backToLogin: string;
    unavailableTitle: string;
    unavailable: string;
  };
  done: {
    title: string;
    message: string;
    mcpHint: string;
  };
  upload: {
    title: string;
    file: string;
    submit: string;
    uploaded: string;
    expired: string;
    forbidden: string;
    invalid: string;
    error: string;
    failed: string;
  };
};

const DICTIONARIES: Record<Language, Dictionary> = { de, en, es, fr, it, ru };

/** `true` for one of the six tenant languages a `settings.language` column may hold. */
export function isLanguage(value: string): value is Language {
  return value in DICTIONARIES;
}

/** The dictionary for `language`, falling back to English for an unrecognised value. */
export function dictionaryFor(language: string): Dictionary {
  return isLanguage(language) ? DICTIONARIES[language] : DICTIONARIES.en;
}

/** Substitutes `{name}` placeholders in `template` from `params` (no template engine on the
 *  client, §5.2: the six shipped dictionaries use this instead of Handlebars). */
export function format(
  template: string,
  params: Record<string, string>
): string {
  let result = '';
  let consumed = 0;
  for (const match of template.matchAll(/\{(?<name>\w+)\}/gu)) {
    const name = match.groups?.name;
    const value =
      name !== undefined && Object.hasOwn(params, name)
        ? params[name]
        : undefined;
    result += template.slice(consumed, match.index);
    result += value ?? match[0];
    consumed = match.index + match[0].length;
  }
  return result + template.slice(consumed);
}
