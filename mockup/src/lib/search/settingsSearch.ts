/**
 * The top bar's search over the app itself: its pages, by name and then by a few search words
 * (`search.keywords.<page>`: "Webhooks" finds "KI & API"), and every configurable field of the
 * field registry, by its label, then by its help text, the name of its record kind ("Webhook") or
 * its technical name (`tlsVerify` is found by "tls"), which is never shown. A plural finds its
 * singular. Among equal matches, the fields of the page in view come first. Runs in the browser; the API's
 * `search.query` covers people, groups and contacts. A person finds only what they may see: an
 * employee their own settings, an admin no owner field hidden from admins. An Expert-only field
 * or page is found with Expert mode off too, marked, and opening it turns Expert mode on.
 */
import type { Role } from '#lib/api/types.js';
import { allEntityFields, fieldAccess } from '#lib/fields/registry.js';
import { has, t } from '#lib/i18n/index.svelte.js';
import { pageAt, PAGES, visiblePages, type PageDef } from '#lib/nav.js';
import { match } from '#lib/state/router.svelte.js';

import { placeOf, SELF_ENTITIES, type Place } from './places';

export type PageHit = { kind: 'page'; page: PageDef; expert: boolean };
export type FieldHit = {
  kind: 'field';
  entity: string;
  key: string;
  label: string;
  /** Page and tab, `Einstellungen › Telefonie`. */
  where: string;
  place: Place;
  expert: boolean;
};

/** Lower case without accents, so `uberschrift` finds `Überschrift`. */
export const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replaceAll('ß', 'ss')
    .toLowerCase();

/** `needle` and, for a longer word, its stem without a plural ending: "webhooks" → "webhook". */
function forms(needle: string): string[] {
  const stem = needle.replace(/(en|n|s|e)$/u, '');
  return needle.length >= 5 && stem !== needle ? [needle, stem] : [needle];
}

/** How well `text` matches `needle`: 0 a prefix, 1 a word's start, 2 anywhere, null not at all. */
function rank(text: string, needle: string): number | null {
  const folded = fold(text);
  const scores = forms(needle).map((form): number | null => {
    if (folded.startsWith(form)) {
      return 0;
    }
    if (folded.split(/[^\p{L}\p{N}]+/u).some(word => word.startsWith(form))) {
      return 1;
    }
    return folded.includes(form) ? 2 : null;
  });
  const found = scores.filter((score): score is number => score !== null);
  return found.length === 0 ? null : Math.min(...found);
}

/** `text` matches `needle` anywhere (a help text, a record kind). */
const mentions = (text: string, needle: string): boolean =>
  rank(text, needle) !== null;

/** Pages whose name matches `query`, best first. */
export function searchPages(
  query: string,
  role: Role,
  expertOn: boolean,
  limit = 4
): PageHit[] {
  const needle = fold(query.trim());
  if (needle === '') {
    return [];
  }
  return visiblePages(role, role !== 'user')
    .map(page => {
      const keywords = `search.keywords.${page.id}`;
      const byName = rank(t(page.label), needle);
      const byKeyword =
        has(keywords) && mentions(t(keywords), needle) ? 3 : null;
      return { page, score: byName ?? byKeyword };
    })
    .filter(
      (entry): entry is { page: PageDef; score: number } => entry.score !== null
    )
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map(({ page }) => ({
      kind: 'page' as const,
      page,
      expert: page.expertOnly === true && !expertOn
    }));
}

/** Fields whose label (or, ranked lower, help text or name) matches `query`, best first; `path`
 * is the page in view. */
export function searchFields(
  query: string,
  role: Role,
  expertOn: boolean,
  limit = 6,
  path = ''
): FieldHit[] {
  const needle = fold(query.trim());
  if (needle === '') {
    return [];
  }
  const self = role === 'user';
  const pages = visiblePages(role, !self);
  const here = pageAt(path);
  const hits: (FieldHit & { score: number; here: boolean })[] = [];
  for (const entity of allEntityFields()) {
    if (self && !SELF_ENTITIES.has(entity.entity)) {
      continue;
    }
    for (const field of entity.fields) {
      const labelKey = `field.${entity.entity}.${field.key}`;
      const access = fieldAccess(entity.entity, field.key, role, !self, self);
      const place = placeOf(entity.entity, field.key, self);
      const page = place === null ? undefined : pageAt(place.path);
      if (
        !has(labelKey) ||
        !access.visible ||
        place === null ||
        page === undefined ||
        !pages.includes(page)
      ) {
        continue;
      }
      const label = t(labelKey);
      const helpKey = `${labelKey}.help`;
      const byLabel = rank(label, needle);
      const kindKey = `audit.kind.${entity.entity}`;
      const byHelp = has(helpKey) && mentions(t(helpKey), needle) ? 3 : null;
      // Every setting is of the kind "Einstellungen": that name would list them all.
      const byKind =
        entity.entity !== 'settings' &&
        has(kindKey) &&
        mentions(t(kindKey), needle)
          ? 3
          : null;
      const byName = fold(
        field.key.replaceAll(/([a-z])([A-Z])/gu, '$1 $2')
      ).includes(needle)
        ? 3
        : null;
      const score = byLabel ?? byHelp ?? byKind ?? byName;
      if (score === null) {
        continue;
      }
      hits.push({
        kind: 'field',
        entity: entity.entity,
        key: field.key,
        label,
        where:
          place.tabLabel === undefined
            ? t(page.label)
            : `${t(page.label)} › ${t(place.tabLabel)}`,
        place,
        expert:
          !expertOn && (field.tier === 'expert' || page.expertOnly === true),
        score,
        here: page === here
      });
    }
  }
  return hits
    .sort(
      (a, b) =>
        a.score - b.score ||
        Number(b.here) - Number(a.here) ||
        a.label.localeCompare(b.label)
    )
    .slice(0, limit)
    .map(({ score: _score, here: _here, ...hit }) => hit);
}

/** Where opening `place` goes from `path`: into the record in view, else the place's page. */
export function placePath(place: Place, path: string): string {
  if (place.record !== undefined) {
    const params = match(`${place.record.base}/:id/:tab?`, path);
    if (params?.id !== undefined) {
      return `${place.record.base}/${params.id}${place.record.tab === undefined ? '' : `/${place.record.tab}`}`;
    }
  }
  return place.path;
}
