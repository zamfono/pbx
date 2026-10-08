import { describe, expect, it } from 'vitest';

import '#lib/fields/index.js';

import { allEntityFields } from '#lib/fields/registry.js';
import { has } from '#lib/i18n/index.svelte.js';
import { pageAt } from '#lib/nav.js';

import { placeOf, SELF_ENTITIES } from './places';
import { placePath, searchFields, searchPages } from './settingsSearch';

const fieldsOf = (hits: { entity: string; key: string }[]): string[] =>
  hits.map(hit => `${hit.entity}.${hit.key}`);

describe('places', () => {
  it('puts every registry field on a page, with a tab label that exists', () => {
    for (const entity of allEntityFields()) {
      for (const field of entity.fields) {
        for (const self of [false, true]) {
          if (self && !SELF_ENTITIES.has(entity.entity)) {
            continue;
          }
          const place = placeOf(entity.entity, field.key, self);
          const where = `${entity.entity}.${field.key}${self ? ' (own)' : ''}`;
          expect(place, where).not.toBeNull();
          expect(pageAt(place?.path ?? ''), where).toBeDefined();
          if (place?.tabLabel !== undefined) {
            expect(has(place.tabLabel), `${where}: ${place.tabLabel}`).toBe(
              true
            );
          }
        }
      }
    }
  });

  it('opens a field of a record in the record in view, else on the list', () => {
    const place = placeOf('ringGroup', 'rules', false);
    expect(place).not.toBeNull();
    if (place !== null) {
      expect(placePath(place, '/ring-groups/rg1/schedule')).toBe(
        '/ring-groups/rg1/forwarding'
      );
      expect(placePath(place, '/overview')).toBe('/ring-groups');
    }
  });
});

describe('settings search', () => {
  it('finds a field by its label, with where it is', () => {
    const [hit] = searchFields('Notrufnummern', 'admin', true);
    expect(hit?.key).toBe('emergencyNumbers');
    expect(hit?.place.path).toBe('/settings/featureCodes');
    expect(hit?.expert).toBe(false);
  });

  it('marks an Expert field while Expert mode is off', () => {
    const hit = searchFields('Zertifikatsprüfung', 'admin', false).find(
      candidate => candidate.entity === 'trunk'
    );
    expect(hit?.expert).toBe(true);
    expect(
      searchFields('Zertifikatsprüfung', 'admin', true).find(
        candidate => candidate.entity === 'trunk'
      )?.expert
    ).toBe(false);
  });

  it('finds owner fields hidden from admins only for owners', () => {
    expect(fieldsOf(searchFields('Passwort', 'admin', true, 50))).not.toContain(
      'settings.smtpPassword'
    );
    expect(fieldsOf(searchFields('Passwort', 'owner', true, 50))).toContain(
      'settings.smtpPassword'
    );
  });

  it('finds an employee only their own settings and pages', () => {
    const hits = searchFields('Weiterleitung', 'user', false, 50);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every(hit => SELF_ENTITIES.has(hit.entity))).toBe(true);
    expect(hits.every(hit => hit.place.path.startsWith('/me'))).toBe(true);
    expect(searchFields('Notrufnummern', 'user', false)).toEqual([]);
    expect(searchPages('Backups', 'user', false)).toEqual([]);
  });

  it('finds a field by its technical name too', () => {
    expect(fieldsOf(searchFields('tls', 'owner', true, 50))).toContain(
      'trunk.tlsVerify'
    );
  });

  it('lists the fields of the page in view first among equal matches', () => {
    expect(
      searchFields('tls', 'owner', true, 50, '/trunks/t1')[0]?.entity
    ).toBe('trunk');
  });

  it('finds a page by its search words and a field by its record kind, plural or not', () => {
    expect(
      searchPages('Webhooks', 'admin', true).map(hit => hit.page.id)
    ).toContain('integrations');
    expect(fieldsOf(searchFields('Webhooks', 'admin', true, 50))).toContain(
      'webhook.url'
    );
  });

  it('ignores case and accents', () => {
    expect(
      fieldsOf(searchFields('zertifikatsprufung', 'owner', true))
    ).toContain('trunk.tlsVerify');
  });
});
