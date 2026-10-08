<!--
  Statistics (admin): the four `stats.query` metrics — call volume, answer rate, time to answer,
  call length — over today, 7 or 30 days, bucketed by hour, day or week, for every call or one
  ring group's offers; and "who was available at …" from `presenceLog.snapshot`.
-->
<script lang="ts">
  import Clock from '@lucide/svelte/icons/clock';
  import Hourglass from '@lucide/svelte/icons/hourglass';
  import PhoneCall from '@lucide/svelte/icons/phone-call';
  import Target from '@lucide/svelte/icons/target';
  import UsersRound from '@lucide/svelte/icons/users-round';

  import { read } from '#lib/actions.svelte.js';
  import { liveRingGroups, liveUsers } from '#lib/api/lookup.js';
  import type { Page } from '#lib/api/ops/areas/calls.js';
  import type {
    BucketUnit,
    Metric,
    StatsBucket
  } from '#lib/api/ops/areas/stats.js';
  import type { PresenceLogEntry, PresenceStatus } from '#lib/api/types.js';
  import { dateOfInstant, localDate } from '#lib/components/calls/dates.js';
  import TimeChart from '#lib/components/calls/TimeChart.svelte';
  import {
    formatDuration,
    formatNumber,
    formatTime,
    i18n,
    t
  } from '#lib/i18n/index.svelte.js';
  import Avatar from '#lib/ui/Avatar.svelte';
  import Card from '#lib/ui/Card.svelte';
  import PageHeader from '#lib/ui/PageHeader.svelte';
  import Segmented from '#lib/ui/Segmented.svelte';
  import Select from '#lib/ui/Select.svelte';
  import Stat from '#lib/ui/Stat.svelte';
  import TextInput from '#lib/ui/TextInput.svelte';

  type Range = 'today' | 'week' | 'month';
  const BUCKETS: Record<Range, BucketUnit[]> = {
    today: ['hour'],
    week: ['hour', 'day'],
    month: ['day', 'week']
  };

  let range = $state<Range>('week');
  let bucket = $state<BucketUnit>('day');
  let ringGroupId = $state<string>('all');

  const allowedBuckets = $derived(BUCKETS[range]);
  const unit = $derived(
    allowedBuckets.includes(bucket) ? bucket : (allowedBuckets[0] ?? 'day')
  );
  const span = $derived(
    range === 'today'
      ? { from: `${localDate(0)}T07:00`, to: `${localDate(0)}T19:00` }
      : { from: localDate(range === 'week' ? 6 : 29), to: localDate(0) }
  );

  function query(metric: Metric): StatsBucket[] {
    return read<{ buckets: StatsBucket[] }>(
      'stats.query',
      {
        metric,
        ...span,
        bucket: unit,
        ...(ringGroupId === 'all' ? {} : { ringGroupId })
      },
      { buckets: [] }
    ).buckets;
  }

  const volume = $derived(query('callVolume'));
  const answerRate = $derived(query('answerRate'));
  const ringToAnswer = $derived(query('ringToAnswer'));
  const callLength = $derived(query('avgCallLength'));

  const total = $derived(
    volume.reduce((sum, item) => sum + (item.value ?? 0), 0)
  );

  /** A rate or mean over the range, each bucket weighted by its calls. */
  function weighted(
    series: StatsBucket[],
    weightOf: (index: number) => number
  ): number | null {
    let sum = 0;
    let weight = 0;
    series.forEach((item, index) => {
      if (item.value !== null) {
        const w = weightOf(index);
        sum += item.value * w;
        weight += w;
      }
    });
    return weight === 0 ? null : sum / weight;
  }

  const overallRate = $derived(
    weighted(answerRate, index => volume[index]?.value ?? 0)
  );
  const answeredWeight = (index: number): number =>
    (volume[index]?.value ?? 0) * (answerRate[index]?.value ?? 0);
  const overallRing = $derived(weighted(ringToAnswer, answeredWeight));
  const overallLength = $derived(weighted(callLength, answeredWeight));

  const locale = $derived(i18n.locale === 'de' ? 'de-DE' : 'en-GB');
  const fmt = $derived({
    hour: new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Berlin'
    }),
    day: new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      day: 'numeric',
      timeZone: 'Europe/Berlin'
    }),
    dayLong: new Intl.DateTimeFormat(locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: 'Europe/Berlin'
    }),
    hourLong: new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Berlin'
    })
  });

  /** The ISO week of the tenant-local date of `iso`. */
  function isoWeek(iso: string): number {
    const [year = 0, month = 1, day = 1] = dateOfInstant(iso)
      .split('-')
      .map(Number);
    const dayMs = Date.UTC(year, month - 1, day);
    const weekday = new Date(dayMs).getUTCDay() || 7;
    const thursday = dayMs + (4 - weekday) * 86_400_000;
    const yearStart = Date.UTC(new Date(thursday).getUTCFullYear(), 0, 1);
    return Math.ceil(((thursday - yearStart) / 86_400_000 + 1) / 7);
  }

  function tick(start: string): string {
    if (unit === 'hour') {
      return range === 'today'
        ? fmt.hour.format(new Date(start))
        : fmt.day.format(new Date(start));
    }
    if (unit === 'week') {
      return t('calls.stats.week', { week: isoWeek(start) });
    }
    return fmt.day.format(new Date(start));
  }

  function long(start: string): string {
    if (unit === 'hour') {
      return fmt.hourLong.format(new Date(start));
    }
    if (unit === 'week') {
      return t('calls.stats.weekOf', {
        week: isoWeek(start),
        date: fmt.dayLong.format(new Date(start))
      });
    }
    return fmt.dayLong.format(new Date(start));
  }

  const percent = (value: number): string => `${Math.round(value * 100)} %`;
  const seconds = (value: number): string => `${Math.round(value)} s`;
  const minutes = (value: number): string => formatDuration(Math.round(value));
  /** A scale top in whole 4-minute steps, so each quarter gridline is a whole minute. */
  const lengthTop = $derived(
    Math.max(
      240,
      Math.ceil(Math.max(0, ...callLength.map(item => item.value ?? 0)) / 240) *
        240
    )
  );
  /** A scale top in 4-second steps for the time to answer. */
  const ringTop = $derived(
    Math.max(
      8,
      Math.ceil(Math.max(0, ...ringToAnswer.map(item => item.value ?? 0)) / 4) *
        4
    )
  );

  const groupOptions = $derived([
    { value: 'all', label: t('calls.stats.allCalls') },
    ...liveRingGroups().map(group => ({ value: group.id, label: group.name }))
  ]);

  /* ---- presence snapshot ---- */

  let at = $state(`${localDate(0)}T10:15`);
  const snapshot = $derived(
    read<Page<PresenceLogEntry>>(
      'presenceLog.snapshot',
      { at, limit: 200 },
      { items: [], nextCursor: null }
    ).items
  );
  const people = $derived(
    liveUsers()
      .filter(user => user.extension !== null)
      .map(user => ({
        user,
        entry: snapshot.find(entry => entry.userId === user.id) ?? null
      }))
  );
  const ORDER: (PresenceStatus | 'unknown')[] = [
    'available',
    'busy',
    'dnd',
    'offline',
    'unknown'
  ];
  const byStatus = $derived(
    ORDER.map(status => ({
      status,
      people: people.filter(
        person => (person.entry?.status ?? 'unknown') === status
      )
    })).filter(group => group.people.length > 0)
  );
</script>

<PageHeader title={t('nav.stats')} subtitle={t('calls.stats.subtitle')} />

<div class="controls">
  <Segmented
    bind:value={range}
    ariaLabel={t('calls.stats.range')}
    options={[
      { value: 'today', label: t('calls.range.today') },
      { value: 'week', label: t('calls.range.week') },
      { value: 'month', label: t('calls.range.month') }
    ]}
  />
  {#if allowedBuckets.length > 1}
    <Segmented
      value={unit}
      size="sm"
      ariaLabel={t('calls.stats.bucket')}
      options={allowedBuckets.map(value => ({
        value,
        label: t(`calls.stats.by.${value}`)
      }))}
      onchange={value => (bucket = value)}
    />
  {/if}
  <Select id="stats-group" bind:value={ringGroupId} options={groupOptions} />
</div>

<div class="stack" style="--gap: var(--space-4)">
  <div class="tiles">
    <Stat
      label={ringGroupId === 'all'
        ? t('calls.stats.metric.callVolume')
        : t('calls.stats.metric.offers')}
      value={formatNumber(total)}
      icon={PhoneCall}
      tone="primary"
    />
    <Stat
      label={t('calls.stats.metric.answerRate')}
      value={overallRate === null ? '—' : percent(overallRate)}
      icon={Target}
      hint={t('calls.stats.answerRateHint')}
    />
    <Stat
      label={t('calls.stats.metric.ringToAnswer')}
      value={overallRing === null ? '—' : seconds(overallRing)}
      icon={Hourglass}
      hint={t('calls.stats.ringToAnswerHint')}
    />
    <Stat
      label={t('calls.stats.metric.avgCallLength')}
      value={overallLength === null ? '—' : minutes(overallLength)}
      icon={Clock}
      hint={t('calls.stats.avgCallLengthHint')}
    />
  </div>

  <Card
    title={t('calls.stats.metric.callVolume')}
    description={t('calls.stats.volumeHelp')}
  >
    <TimeChart
      buckets={volume}
      kind="bar"
      format={value => formatNumber(Math.round(value))}
      {tick}
      {long}
      label={t('calls.stats.metric.callVolume')}
      height={240}
    />
  </Card>

  <div class="grid-2">
    <Card
      title={t('calls.stats.metric.answerRate')}
      description={t('calls.stats.answerRateHelp')}
    >
      <TimeChart
        buckets={answerRate}
        kind="line"
        format={percent}
        max={1}
        {tick}
        {long}
        tone="ok"
        label={t('calls.stats.metric.answerRate')}
      />
    </Card>
    <Card
      title={t('calls.stats.metric.ringToAnswer')}
      description={t('calls.stats.ringToAnswerHelp')}
    >
      <TimeChart
        buckets={ringToAnswer}
        kind="line"
        format={seconds}
        max={ringTop}
        {tick}
        {long}
        tone="warn"
        label={t('calls.stats.metric.ringToAnswer')}
      />
    </Card>
  </div>

  <Card
    title={t('calls.stats.metric.avgCallLength')}
    description={t('calls.stats.avgCallLengthHelp')}
  >
    <TimeChart
      buckets={callLength}
      kind="bar"
      format={minutes}
      max={lengthTop}
      {tick}
      {long}
      tone="info"
      label={t('calls.stats.metric.avgCallLength')}
      height={200}
    />
  </Card>

  <Card
    title={t('calls.stats.presence.title')}
    description={t('calls.stats.presence.help')}
    icon={UsersRound}
  >
    {#snippet actions()}
      <div class="at">
        <TextInput
          id="stats-presence-at"
          type="datetime-local"
          bind:value={at}
        />
      </div>
    {/snippet}
    <div class="presence">
      {#each byStatus as group (group.status)}
        <section class="status-group {group.status}">
          <h4>
            <span class="dot"></span>{group.status === 'unknown'
              ? t('calls.stats.presence.unknown')
              : t(`presence.${group.status}`)}
            <span class="count">{group.people.length}</span>
          </h4>
          <ul>
            {#each group.people as person (person.user.id)}
              <li>
                <Avatar name={person.user.name} size={28} />
                <span class="person">
                  <span class="small strong truncate">{person.user.name}</span>
                  {#if person.entry}
                    <span class="xs muted"
                      >{t('calls.stats.presence.since', {
                        time: formatTime(person.entry.since)
                      })}</span
                    >
                  {/if}
                </span>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    </div>
  </Card>
</div>

<style>
  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
    margin-bottom: var(--space-4);
  }
  .tiles {
    display: grid;
    gap: var(--space-3);
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr));
  }
  .at {
    width: 220px;
  }
  .presence {
    display: grid;
    gap: var(--space-4);
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
  }
  .status-group h4 {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-body);
    font-size: var(--text-sm);
    font-weight: 700;
    margin-bottom: var(--space-2);
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--presence-offline);
  }
  .available .dot {
    background: var(--presence-available);
  }
  .busy .dot {
    background: var(--presence-busy);
  }
  .dnd .dot {
    background: var(--presence-dnd);
  }
  .count {
    margin-left: auto;
    color: var(--text-muted);
    font-weight: 600;
  }
  .status-group ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .status-group li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .person {
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.25;
  }
  @media (max-width: 640px) {
    .at {
      width: 100%;
    }
  }
</style>
