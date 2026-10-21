/**
 * The tenant's time zone on a Yealink phone (§10.4 "Provisioning link"): the phone names zones its
 * own way, an offset and a location whose DST rules it applies itself.
 */
import { MINUTES_PER_HOUR } from '@zamfono/shared';

const MINUTE_DIGITS = 2;

// IANA zone → Yealink's standard offset and zone name, whose DST rules the phone applies itself.
export const TIME_ZONES: Record<string, [string, string]> = {
  UTC: ['0', 'GMT'],
  'Etc/UTC': ['0', 'GMT'],
  'Europe/London': ['0', 'United Kingdom(London)'],
  'Europe/Dublin': ['0', 'Ireland(Dublin)'],
  'Europe/Lisbon': ['0', 'Portugal(Lisboa,Porto,Funchal)'],
  'Europe/Vienna': ['+1', 'Austria(Vienna)'],
  'Europe/Berlin': ['+1', 'Germany(Berlin)'],
  'Europe/Zurich': ['+1', 'Switzerland(Bern)'],
  'Europe/Brussels': ['+1', 'Belgium(Brussels)'],
  'Europe/Paris': ['+1', 'France(Paris)'],
  'Europe/Rome': ['+1', 'Italy(Rome)'],
  'Europe/Madrid': ['+1', 'Spain(Madrid)'],
  'Europe/Amsterdam': ['+1', 'Netherlands(Amsterdam)'],
  'Europe/Luxembourg': ['+1', 'Luxembourg(Luxembourg)'],
  'Europe/Copenhagen': ['+1', 'Denmark(Kopenhagen)'],
  'Europe/Stockholm': ['+1', 'Sweden(Stockholm)'],
  'Europe/Warsaw': ['+1', 'Poland(Warsaw)'],
  'Europe/Prague': ['+1', 'Czech Republic(Prague)'],
  'Europe/Bratislava': ['+1', 'Bratislava'],
  'Europe/Ljubljana': ['+1', 'Ljubljana'],
  'Europe/Belgrade': ['+1', 'Belgrade'],
  'Europe/Zagreb': ['+1', 'Croatia(Zagreb)'],
  'Europe/Budapest': ['+1', 'Hungary(Budapest)'],
  'Europe/Skopje': ['+1', 'Macedonia(Skopje)'],
  'Europe/Tirane': ['+1', 'Albania(Tirane)'],
  'Europe/Helsinki': ['+2', 'Finland(Helsinki)'],
  'Europe/Tallinn': ['+2', 'Estonia(Tallinn)'],
  'Europe/Riga': ['+2', 'Latvia(Riga)'],
  'Europe/Vilnius': ['+2', 'Lithuania(Vilnius)'],
  'Europe/Athens': ['+2', 'Greece(Athens)'],
  'Europe/Sofia': ['+2', 'Bulgaria(Sofia)'],
  'Europe/Bucharest': ['+2', 'Romania(Bucharest)'],
  'Europe/Kyiv': ['+2', 'Ukraine(Kyiv, Odessa)'],
  'Europe/Kaliningrad': ['+2', 'Russia(Kaliningrad)'],
  'Europe/Moscow': ['+3', 'Russia(Moscow)'],
  'Europe/Minsk': ['+3', 'Minsk'],
  'America/New_York': ['-5', 'United States-Eastern Time'],
  'America/Toronto': ['-5', 'Canada(Montreal,Ottawa,Quebec)'],
  'America/Chicago': ['-6', 'United States-Central Time'],
  'America/Denver': ['-7', 'United States-Mountain Time'],
  'America/Phoenix': ['-7', 'Arizona'],
  'America/Los_Angeles': ['-8', 'United States-Pacific Time'],
  'America/Vancouver': ['-8', 'Canada(Vancouver,Whitehorse)'],
  'America/Anchorage': ['-9', 'United States-Alaska Time'],
  'Pacific/Honolulu': ['-10', 'United States-Hawaii-Aleutian'],
  'Asia/Dubai': ['+4', 'Abu Dhabi,Muscat'],
  'Asia/Kolkata': ['+5:30', 'India(Calcutta)'],
  'Asia/Shanghai': ['+8', 'China(Beijing)'],
  'Asia/Singapore': ['+8', 'Singapore(Singapore)'],
  'Asia/Tokyo': ['+9', 'Japan(Tokyo)'],
  'Australia/Perth': ['+8', 'Australia(Perth)'],
  'Australia/Sydney': ['+10', 'Australia(Sydney,Melbourne,Canberra)'],
  'Australia/Melbourne': ['+10', 'Australia(Sydney,Melbourne,Canberra)'],
  'Pacific/Auckland': ['+12', 'New Zealand(Wellington,Auckland)']
};

/** `minutes` east of UTC in Yealink's form: `0`, `+1`, `-3:30`, `+5:45`. */
export function yealinkOffset(minutes: number): string {
  if (minutes === 0) {
    return '0';
  }
  const sign = minutes < 0 ? '-' : '+';
  const hours = Math.floor(Math.abs(minutes) / MINUTES_PER_HOUR);
  const rest = Math.abs(minutes) % MINUTES_PER_HOUR;
  const tail =
    rest === 0 ? '' : `:${String(rest).padStart(MINUTE_DIGITS, '0')}`;
  return `${sign}${hours}${tail}`;
}

/** `zone`'s offset from UTC at `at`, in minutes east. */
export function utcOffsetMinutes(zone: string, at: Date): number {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    timeZoneName: 'longOffset'
  })
    .formatToParts(at)
    .find(part => part.type === 'timeZoneName')?.value;
  const groups = /GMT(?<sign>[+-])(?<hours>\d{2}):(?<minutes>\d{2})/u.exec(
    name ?? ''
  )?.groups;
  if (groups === undefined) {
    return 0;
  }
  const minutes =
    Number(groups.hours) * MINUTES_PER_HOUR + Number(groups.minutes);
  return groups.sign === '-' ? -minutes : minutes;
}

/** The time-zone lines for IANA `zone`. */
export function timeZoneLines(zone: string, now: Date): [string, string][] {
  const mapped = TIME_ZONES[zone];
  if (mapped !== undefined) {
    return [
      ['local_time.time_zone', mapped[0]],
      ['local_time.time_zone_name', mapped[1]],
      ['local_time.summer_time', '2']
    ];
  }
  // ponytail: a zone without a Yealink name gets today's offset without DST rules, so after a DST
  // change the clock is off until the next nightly fetch; add the zone to TIME_ZONES to fix that.
  return [
    ['local_time.time_zone', yealinkOffset(utcOffsetMinutes(zone, now))],
    ['local_time.summer_time', '0']
  ];
}
