/**
 * One settings card's edits: the card shows the saved settings until a field is edited, saves only
 * its own changed fields in one `settings.update`, and shows refusals next to the field they name.
 * Fields the person may only see (owner-only, for an admin) are never sent.
 */
import { errorText, read, run } from '#lib/actions.svelte.js';
import type { SettingsInput } from '#lib/api/ops/areas/settings.js';
import type { Settings } from '#lib/api/types.js';
import { fieldAccess } from '#lib/fields/registry.js';
import { currentActor, isExpert } from '#lib/state/session.svelte.js';

type Key = keyof SettingsInput;

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
const SECRETS = new Set<string>([
  'smtpPassword',
  'ssoClientSecret',
  'ringotelApiToken'
]);

/** The saved settings as the signed-in person reads them (`settings.get`). */
export function savedSettings(): Settings | null {
  return read<Settings | null>('settings.get', {}, null);
}

export class SettingsForm {
  readonly keys: readonly Key[];
  edits = $state<Partial<Record<Key, unknown>>>({});
  errors = $state<Record<string, string>>({});
  saving = $state(false);

  constructor(keys: readonly Key[]) {
    this.keys = keys;
  }

  /** The value a field shows: the edit, else the saved value (secrets: the pending write). */
  get<K extends Key>(key: K): SettingsInput[K] {
    if (key in this.edits) {
      return this.edits[key] as SettingsInput[K];
    }
    if (SECRETS.has(key)) {
      return undefined as SettingsInput[K];
    }
    return (savedSettings() as Record<string, unknown> | null)?.[
      key
    ] as SettingsInput[K];
  }

  set<K extends Key>(key: K, value: SettingsInput[K]): void {
    this.edits = { ...this.edits, [key]: value };
    if (key in this.errors) {
      const { [key]: _dropped, ...rest } = this.errors;
      this.errors = rest;
    }
  }

  /** Whether the person may change `key` (owner-only fields are display-only for admins). */
  editable(key: Key): boolean {
    return fieldAccess('settings', key, currentActor().role, isExpert())
      .editable;
  }

  /** The changed, editable fields: what a save sends. */
  get changes(): Partial<SettingsInput> {
    const saved = (savedSettings() ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of this.keys) {
      if (!(key in this.edits) || !this.editable(key)) {
        continue;
      }
      const value = this.edits[key];
      if (SECRETS.has(key) ? value !== undefined : !same(value, saved[key])) {
        out[key] = value;
      }
    }
    return out as Partial<SettingsInput>;
  }

  get dirty(): boolean {
    return Object.keys(this.changes).length > 0;
  }

  /** Whether any field of the card is editable for this person. */
  get anyEditable(): boolean {
    return this.keys.some(key => this.editable(key));
  }

  discard(): void {
    this.edits = {};
    this.errors = {};
  }

  error(key: string): string | null {
    return this.errors[key] ?? null;
  }

  async save(): Promise<boolean> {
    const changes = this.changes;
    if (Object.keys(changes).length === 0) {
      return true;
    }
    this.saving = true;
    const result = await run('settings.update', changes, {
      success: 'settings.saved'
    });
    this.saving = false;
    if (result.ok) {
      this.discard();
      return true;
    }
    if (result.error.field !== null) {
      this.errors = {
        ...this.errors,
        [result.error.field]: errorText(result.error)
      };
    }
    return false;
  }
}
