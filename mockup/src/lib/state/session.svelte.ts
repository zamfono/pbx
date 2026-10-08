/**
 * Who is signed in and how they view the app: the demo persona, Expert mode (per persona), theme,
 * language, Mucki's panel and the simulator. Preferences persist per browser; storage failures
 * leave the defaults in place.
 */
import type { Actor } from '#lib/api/ops/core.js';
import { PERSONAS, type PersonaKey } from '#lib/api/seed/ids.js';
import { store } from '#lib/api/store.svelte.js';
import { i18n, type Locale } from '#lib/i18n/index.svelte.js';

const PREFS_KEY = 'zamfono-mockup:prefs:v1';

export type Theme = 'system' | 'light' | 'dark';

type Prefs = {
  signedIn: boolean;
  persona: PersonaKey;
  expert: Record<PersonaKey, boolean>;
  theme: Theme;
  locale: Locale;
  muckiOpen: boolean;
  muckiWidth: number;
  demoBarCollapsed: boolean;
  simulatorPaused: boolean;
  /** Until when the security page's own short session lasts (`/auth/security`, 10 minutes). */
  securityUntil: string | null;
};

const defaults: Prefs = {
  signedIn: false,
  persona: 'jonas',
  expert: { lea: false, jonas: false, mira: false },
  theme: 'system',
  locale: 'de',
  muckiOpen: true,
  muckiWidth: 380,
  demoBarCollapsed: false,
  simulatorPaused: false,
  securityUntil: null
};

/** Who is signed in is kept per tab (sessionStorage), so two tabs can show two people; the rest
 * of the preferences, and the persona a new tab starts with, come from localStorage. */
const TAB_KEY = 'zamfono-mockup:tab:v1';
type TabPrefs = Pick<Prefs, 'signedIn' | 'persona' | 'securityUntil'>;

function loadPrefs(): Prefs {
  let prefs: Prefs = { ...defaults };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw !== null) {
      prefs = { ...prefs, ...(JSON.parse(raw) as Partial<Prefs>) };
    }
    const tab = sessionStorage.getItem(TAB_KEY);
    if (tab !== null) {
      prefs = { ...prefs, ...(JSON.parse(tab) as Partial<TabPrefs>) };
    }
  } catch {
    // Storage blocked: defaults.
  }
  return prefs;
}

export const session = $state<Prefs>(loadPrefs());
i18n.locale = session.locale;

export function savePrefs(): void {
  try {
    const snapshot = $state.snapshot(session);
    localStorage.setItem(PREFS_KEY, JSON.stringify(snapshot));
    const tab: TabPrefs = {
      signedIn: snapshot.signedIn,
      persona: snapshot.persona,
      securityUntil: snapshot.securityUntil
    };
    sessionStorage.setItem(TAB_KEY, JSON.stringify(tab));
  } catch {
    // Storage blocked: the preference lasts for this page load.
  }
}

export function setLocale(locale: Locale): void {
  session.locale = locale;
  i18n.locale = locale;
  document.documentElement.lang = locale;
  savePrefs();
}

export function setTheme(theme: Theme): void {
  session.theme = theme;
  applyTheme();
  savePrefs();
}

export function applyTheme(): void {
  if (session.theme === 'system') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = session.theme;
  }
}

/** The theme in effect, resolving `system` against the OS preference. */
export function effectiveTheme(): 'light' | 'dark' {
  if (session.theme !== 'system') {
    return session.theme;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export function personaUserId(key: PersonaKey): string {
  return PERSONAS.find(persona => persona.key === key)?.userId ?? '';
}

/** The signed-in person as the operations layer sees them: role read from the tenant each time. */
export function currentActor(): Actor {
  const userId = personaUserId(session.persona);
  const user = store.db.users.find(candidate => candidate.id === userId);
  return {
    id: userId,
    name: user?.name ?? '',
    role: user?.role ?? 'user'
  };
}

/** Expert mode is for admins and owners; a `user` has no technical settings to reveal. */
export function isExpert(): boolean {
  return currentActor().role !== 'user' && session.expert[session.persona];
}

export function setExpert(on: boolean): void {
  session.expert[session.persona] = on;
  savePrefs();
}

export function switchPersona(key: PersonaKey): void {
  session.persona = key;
  session.signedIn = true;
  session.securityUntil = null;
  savePrefs();
}

export function signIn(key: PersonaKey): void {
  switchPersona(key);
}

export function signOut(): void {
  session.signedIn = false;
  session.securityUntil = null;
  savePrefs();
}
