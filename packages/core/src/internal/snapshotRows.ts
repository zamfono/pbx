/**
 * The config snapshot's rows with their JSON columns decoded (§11.2): each `*Json` column becomes
 * the same-named field without the suffix, so the routing pipeline never re-parses one.
 */
import type { Selectable } from 'kysely';

import {
  allowedIpsColumn,
  codecsColumn,
  emergencyNumbersColumn,
  featureCodesColumn,
  findMeColumn,
  sipHeadersColumn,
  type Codec,
  type DB,
  type FeatureCodes,
  type FindMeLeg,
  type SipHeaderTemplate
} from '@zamfono/shared';

export type ConfigRow<K extends keyof DB> = Omit<
  Selectable<DB[K]>,
  'deletedAt'
>;

export type ParsedUser = Omit<ConfigRow<'users'>, 'findMeJson'> & {
  findMe: FindMeLeg[];
};
export type ParsedDevice = Omit<ConfigRow<'devices'>, 'allowedIpsJson'> & {
  allowedIps: string[] | null;
};
export type ParsedTrunk = Omit<ConfigRow<'trunks'>, 'codecsJson'> & {
  codecs: Codec[] | null;
};
export type ParsedForwardTarget = Omit<
  ConfigRow<'forwardTargets'>,
  'sipHeadersJson'
> & {
  sipHeaders: SipHeaderTemplate[] | null;
};
export type ParsedSettings = Omit<
  Selectable<DB['settings']>,
  'codecsJson' | 'emergencyNumbersJson' | 'featureCodesJson'
> & {
  codecs: Codec[];
  emergencyNumbers: string[];
  featureCodes: FeatureCodes;
};

export function parseUser(row: ConfigRow<'users'>): ParsedUser {
  const { findMeJson, ...rest } = row;
  return { ...rest, findMe: findMeColumn.decode(findMeJson) };
}

export function parseDevice(row: ConfigRow<'devices'>): ParsedDevice {
  const { allowedIpsJson, ...rest } = row;
  return {
    ...rest,
    allowedIps: allowedIpsColumn.nullable().decode(allowedIpsJson)
  };
}

export function parseTrunk(row: ConfigRow<'trunks'>): ParsedTrunk {
  const { codecsJson, ...rest } = row;
  return { ...rest, codecs: codecsColumn.nullable().decode(codecsJson) };
}

export function parseForwardTarget(
  row: ConfigRow<'forwardTargets'>
): ParsedForwardTarget {
  const { sipHeadersJson, ...rest } = row;
  return {
    ...rest,
    sipHeaders: sipHeadersColumn.nullable().decode(sipHeadersJson)
  };
}

export function parseSettings(row: Selectable<DB['settings']>): ParsedSettings {
  const { codecsJson, emergencyNumbersJson, featureCodesJson, ...rest } = row;
  return {
    ...rest,
    codecs: codecsColumn.decode(codecsJson),
    emergencyNumbers: emergencyNumbersColumn.decode(emergencyNumbersJson),
    featureCodes: featureCodesColumn.decode(featureCodesJson)
  };
}
