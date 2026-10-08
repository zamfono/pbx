/**
 * Where each configurable field of the field registry is set: the page, the tab and, for a field
 * of a record (a ring group's strategy, a trunk's timers), the record page it opens on when the
 * person is already on one. `places.test.ts` checks every registry field has a place.
 */

/** A field's place. */
export type Place = {
  /** The page that holds the field; for a field of a record, the list of those records. */
  path: string;
  /** i18n key of the tab the field is on, shown after the page's name. */
  tabLabel?: string;
  /** For a field of a record: the record pages (`/ring-groups` + `/:id`) and the field's tab. */
  record?: { base: string; tab?: string };
};

type Resolve = (key: string, self: boolean) => Place;

const SETTINGS_TAB: Record<string, string> = {
  companyName: 'general',
  mainDidId: 'general',
  country: 'general',
  timezone: 'general',
  language: 'general',
  extLength: 'general',
  clir: 'calls',
  rejectAnonymous: 'calls',
  holdMohAudioId: 'calls',
  codecs: 'calls',
  callLogLevel: 'calls',
  voicemailMaxS: 'calls',
  parkingTimeoutS: 'calls',
  fallbackTarget: 'calls',
  emergencyNumbers: 'featureCodes',
  featureCodes: 'featureCodes',
  smtpHost: 'mail',
  smtpPort: 'mail',
  smtpSecurity: 'mail',
  smtpUser: 'mail',
  smtpPassword: 'mail',
  mailFrom: 'mail',
  smtpCheckIntervalS: 'mail',
  mfaRequiredForAll: 'signIn',
  ssoProvider: 'signIn',
  ssoLabel: 'signIn',
  ssoIssuer: 'signIn',
  ssoClientId: 'signIn',
  ssoTenantId: 'signIn',
  ssoAllowedDomain: 'signIn',
  ssoClientSecret: 'signIn',
  recordingRetentionDays: 'retention',
  softDeleteRetentionDays: 'retention',
  auditRetentionDays: 'retention',
  backupCron: 'updates',
  tlsReloadHour: 'updates',
  autoUpdate: 'updates',
  ringotelMaxRegs: 'ringotel',
  ringotelApiToken: 'ringotel'
};

/** A field of a record: the list page, the record page with the field's tab. */
const recordField =
  (base: string, tabs: Record<string, string> = {}, labels = ''): Resolve =>
  key => {
    const tab = tabs[key];
    return {
      path: base,
      ...(tab !== undefined && labels !== ''
        ? { tabLabel: `${labels}.${tab}` }
        : {}),
      record: { base, ...(tab !== undefined ? { tab } : {}) }
    };
  };

const page =
  (path: string, tabLabel?: string): Resolve =>
  () => ({ path, ...(tabLabel !== undefined ? { tabLabel } : {}) });

/** The person's own page (`/me/<tab>`), or a user's record for an admin. */
const personal =
  (tab: string, userTab: string | null): Resolve =>
  (_key, self) =>
    self
      ? {
          path: tab === 'profile' ? '/me' : `/me/${tab}`,
          tabLabel: `people.tab.${tab}`
        }
      : {
          path: '/users',
          ...(userTab !== null ? { tabLabel: `people.tab.${userTab}` } : {}),
          record: {
            base: '/users',
            ...(userTab !== null && userTab !== 'profile'
              ? { tab: userTab }
              : {})
          }
        };

const PLACES: Record<string, Resolve> = {
  settings: key =>
    key.startsWith('sipBan')
      ? { path: '/sip-protection' }
      : {
          path: `/settings/${SETTINGS_TAB[key] ?? 'general'}`,
          tabLabel: `settings.tab.${SETTINGS_TAB[key] ?? 'general'}`
        },
  user: (key, self) => {
    if (key === 'rules') {
      return personal('forwarding', 'forwarding')(key, self);
    }
    if (key === 'upload') {
      return personal('greeting', 'profile')(key, self);
    }
    return personal('profile', 'profile')(key, self);
  },
  device: personal('devices', 'devices'),
  personalAccessToken: personal('tokens', 'tokens'),
  oooRule: (key, self) =>
    self ? personal('schedule', null)(key, self) : { path: '/company-hours' },
  openingHours: (key, self) =>
    self ? personal('schedule', null)(key, self) : { path: '/company-hours' },
  ringGroup: recordField(
    '/ring-groups',
    { rules: 'forwarding' },
    'groups.rg.tab'
  ),
  menu: key =>
    recordField(
      '/menus',
      { [key]: key === 'targets' ? 'keys' : 'settings' },
      'groups.menu.tab'
    )(key, false),
  trunk: recordField('/trunks'),
  trunkOrder: page('/trunks'),
  userGroup: recordField('/user-groups'),
  did: page('/numbers', 'numbers.tab.numbers'),
  didBlock: page('/numbers/blocks', 'numbers.tab.blocks'),
  outboundRoute: page('/outbound-routes'),
  blockedNumber: page('/blocklist'),
  contact: page('/phonebook'),
  audio: page('/audio'),
  parking: page('/parking'),
  mailTemplate: page('/mail-templates'),
  webhook: page('/integrations', 'integrations.webhooks.title'),
  backupTarget: page('/backups'),
  sipAllowlistEntry: page('/sip-protection'),
  ringotel: page('/ringotel'),
  systemUpdate: page('/system')
};

/** Where field `key` of `entity` is set; `self` for a person's own record (a `user`). */
export function placeOf(
  entity: string,
  key: string,
  self: boolean
): Place | null {
  return PLACES[entity]?.(key, self) ?? null;
}

/** The entities whose fields a `user` sets on their own record (`/me`). */
export const SELF_ENTITIES = new Set([
  'user',
  'device',
  'personalAccessToken',
  'oooRule',
  'openingHours'
]);
