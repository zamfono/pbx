<!--
  Overview, the landing page: a greeting with the person's presence and do-not-disturb switch,
  click-to-dial, missed calls today, new voicemail (own and ring-group mailboxes), parked calls and
  recent calls. Admins and owners also see the live calls, the trunks, system health and today's
  call volume (`calls.list`, `voicemails.list`, `parking.list`, `trunks.list`, `system.info`,
  `backups.*`, `stats.query`).
-->
<script lang="ts">
  import Activity from '@lucide/svelte/icons/activity';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import Cable from '@lucide/svelte/icons/cable';
  import ChartColumn from '@lucide/svelte/icons/chart-column';
  import DatabaseBackup from '@lucide/svelte/icons/database-backup';
  import History from '@lucide/svelte/icons/history';
  import Phone from '@lucide/svelte/icons/phone';
  import PhoneMissed from '@lucide/svelte/icons/phone-missed';
  import Server from '@lucide/svelte/icons/server';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import SquareParking from '@lucide/svelte/icons/square-parking';
  import VoicemailIcon from '@lucide/svelte/icons/voicemail';

  import { read, run } from '#lib/actions.svelte.js';
  import { ringGroupsOf } from '#lib/api/events.svelte.js';
  import { liveTrunks, presenceOf, userById } from '#lib/api/lookup.js';
  import type { CallOut, Page } from '#lib/api/ops/areas/calls.js';
  import type { ParkedOut } from '#lib/api/ops/areas/parking.js';
  import type { StatsBucket } from '#lib/api/ops/areas/stats.js';
  import type { VoicemailOut } from '#lib/api/ops/areas/voicemails.js';
  import { store } from '#lib/api/store.svelte.js';
  import type {
    BackupRun,
    BackupTarget,
    LiveCall,
    SystemInfo,
    Trunk
  } from '#lib/api/types.js';
  import { nowDate as demoNowDate } from '#lib/clock.svelte.js';
  import CallListItem from '#lib/components/calls/CallListItem.svelte';
  import { secondsSince } from '#lib/components/calls/clock.svelte.js';
  import { localDate } from '#lib/components/calls/dates.js';
  import DialBox from '#lib/components/calls/DialBox.svelte';
  import {
    cameIn,
    isMissed,
    liveCounterpart,
    partyName
  } from '#lib/components/calls/labels.js';
  import PartyLabel from '#lib/components/calls/PartyLabel.svelte';
  import TimeChart from '#lib/components/calls/TimeChart.svelte';
  import {
    formatDuration,
    formatNumber,
    formatRelative,
    i18n,
    t
  } from '#lib/i18n/index.svelte.js';
  import PresenceToggle from '#lib/shell/PresenceToggle.svelte';
  import { go, href } from '#lib/state/router.svelte.js';
  import { currentActor, isExpert } from '#lib/state/session.svelte.js';
  import Badge from '#lib/ui/Badge.svelte';
  import Button from '#lib/ui/Button.svelte';
  import Card from '#lib/ui/Card.svelte';
  import EmptyState from '#lib/ui/EmptyState.svelte';
  import Stat from '#lib/ui/Stat.svelte';

  const EMPTY = { items: [], nextCursor: null };
  const actor = $derived(currentActor());
  const admin = $derived(actor.role !== 'user');
  const me = $derived(userById(actor.id));
  const firstName = $derived(
    (me?.name ?? '').replace(/^Dr\.\s*/u, '').split(/\s+/u)[0] ?? ''
  );
  const status = $derived(presenceOf(actor.id));

  const hour = $derived(
    Number(
      new Intl.DateTimeFormat('en-GB', {
        hour: 'numeric',
        hourCycle: 'h23',
        timeZone: 'Europe/Berlin'
      }).format(demoNowDate())
    )
  );
  const greeting = $derived(
    hour < 11 ? 'morning' : hour < 18 ? 'day' : 'evening'
  );
  const today = $derived(
    new Intl.DateTimeFormat(i18n.locale === 'de' ? 'de-DE' : 'en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: 'Europe/Berlin'
    }).format(demoNowDate())
  );

  const todays = $derived(
    read<Page<CallOut>>(
      'calls.list',
      { userId: actor.id, from: localDate(0), to: localDate(0), limit: 200 },
      EMPTY
    ).items
  );
  const missedToday = $derived(
    todays.filter(call => cameIn(call, actor.id) && isMissed(call))
  );
  const recent = $derived(
    read<Page<CallOut>>('calls.list', { userId: actor.id, limit: 6 }, EMPTY)
      .items
  );

  const myGroups = $derived(ringGroupsOf(store.db, actor.id));
  const voicemails = $derived(
    read<Page<VoicemailOut>>(
      'voicemails.list',
      { limit: 200 },
      EMPTY
    ).items.filter(
      vm =>
        vm.mailboxUserId === actor.id ||
        (vm.mailboxRingGroupId !== null &&
          myGroups.includes(vm.mailboxRingGroupId))
    )
  );
  const unread = $derived(voicemails.filter(vm => !vm.read));
  const parked = $derived(
    read<Page<ParkedOut>>('parking.list', { limit: 200 }, EMPTY).items
  );
  const live = $derived(
    read<Page<LiveCall>>('calls.list', { live: true, limit: 200 }, EMPTY).items
  );
  const myLive = $derived(live.filter(call => call.userIds.includes(actor.id)));

  /* ---- admin ---- */
  const trunks = $derived(
    admin
      ? read<{ items: Trunk[] }>('trunks.list', {}, { items: liveTrunks() })
          .items
      : []
  );
  const system = $derived(
    admin ? read<SystemInfo | null>('system.info', {}, null) : null
  );
  const targets = $derived(
    admin
      ? read<{ items: Omit<BackupTarget, 'label' | 'deletedAt'>[] }>(
          'backups.targets.list',
          {},
          { items: [] }
        ).items.filter(target => target.enabled)
      : []
  );
  const runs = $derived(
    admin
      ? read<{ items: Omit<BackupRun, 'trigger'>[] }>(
          'backups.runs.list',
          {},
          { items: [] }
        ).items
      : []
  );
  const lastRuns = $derived(
    targets.map(target => ({
      target,
      run:
        runs.find(
          candidate =>
            candidate.targetId === target.id && candidate.status !== 'running'
        ) ?? null
    }))
  );
  const backupsOk = $derived(
    lastRuns.every(entry => entry.run?.status === 'ok')
  );
  const volume = $derived(
    admin
      ? read<{ buckets: StatsBucket[] }>(
          'stats.query',
          {
            metric: 'callVolume',
            from: `${localDate(0)}T07:00`,
            to: `${localDate(0)}T19:00`,
            bucket: 'hour'
          },
          { buckets: [] }
        ).buckets
      : []
  );
  const rate = $derived(
    admin
      ? (read<{ buckets: StatsBucket[] }>(
          'stats.query',
          {
            metric: 'answerRate',
            from: localDate(0),
            to: localDate(0),
            bucket: 'day'
          },
          { buckets: [] }
        ).buckets[0]?.value ?? null)
      : null
  );
  const callsToday = $derived(
    volume.reduce((sum, bucket) => sum + (bucket.value ?? 0), 0)
  );
  const HOUR_FMT = new Intl.DateTimeFormat('de-DE', {
    hour: '2-digit',
    timeZone: 'Europe/Berlin'
  });

  const TRUNK_TONE: Record<
    Trunk['status'],
    'ok' | 'danger' | 'neutral' | 'warn'
  > = {
    registered: 'ok',
    unreachable: 'danger',
    unmonitored: 'neutral',
    unknown: 'warn'
  };
</script>

<div class="overview">
  <section class="hero">
    <div class="hello">
      <p class="date">{today}</p>
      <h1>{t(`calls.overview.greeting.${greeting}`, { name: firstName })}</h1>
      <div class="presence-row">
        <PresenceToggle userId={actor.id} {status} />
        <span class="presence-note"
          >{t(`calls.overview.presence.${status}`)}</span
        >
      </div>
      {#if myLive.length > 0}
        <a class="on-call" href={href('/calls')}>
          <span class="pulse"></span>
          {t('calls.overview.onCall', {
            name: partyName(
              myLive[0] === undefined
                ? ''
                : liveCounterpart(myLive[0], actor.id)
            ),
            duration: formatDuration(
              secondsSince(myLive[0]?.startedAt ?? demoNowDate().toISOString())
            )
          })}
          <ArrowRight size={15} />
        </a>
      {/if}
    </div>
    <div class="dial-panel">
      <h2 class="dial-title"><Phone size={18} /> {t('calls.dial.title')}</h2>
      <DialBox id="overview-dial" compact clirOption={false} />
    </div>
    <div class="deco-clip" aria-hidden="true">
      <svg class="deco" viewBox="0 0 200 200">
        <circle cx="150" cy="40" r="70" />
        <circle cx="190" cy="160" r="34" />
      </svg>
    </div>
  </section>

  <div class="tiles">
    <Stat
      label={t('calls.overview.missedToday')}
      value={missedToday.length}
      icon={PhoneMissed}
      tone={missedToday.length > 0 ? 'danger' : 'default'}
      hint={missedToday.length > 0
        ? t('calls.overview.missedHint', {
            name: partyName(missedToday[0]?.fromUri ?? '')
          })
        : t('calls.overview.missedNone')}
      href={href('/calls')}
    />
    <Stat
      label={t('calls.overview.newVoicemail')}
      value={unread.length}
      icon={VoicemailIcon}
      tone={unread.length > 0 ? 'primary' : 'default'}
      hint={t('calls.overview.voicemailHint', { total: voicemails.length })}
      href={href('/voicemail')}
    />
    <Stat
      label={t('calls.overview.parked')}
      value={parked.length}
      icon={SquareParking}
      hint={parked.length > 0
        ? t('calls.overview.parkedHint', {
            slots: parked.map(entry => entry.slot).join(', ')
          })
        : t('calls.overview.parkedNone')}
      href={admin ? href('/parking') : undefined}
    />
    {#if admin}
      <Stat
        label={t('calls.overview.liveNow')}
        value={live.length}
        icon={Activity}
        tone="lime"
        hint={t('calls.overview.liveHint', { count: callsToday })}
        href={href('/live')}
      />
    {/if}
  </div>

  <div class="grid-2 block">
    <Card title={t('calls.overview.recent')} icon={History} padded={false}>
      {#snippet actions()}
        <Button
          size="sm"
          variant="ghost"
          iconRight={ArrowRight}
          href={href('/calls')}>{t('calls.overview.allCalls')}</Button
        >
      {/snippet}
      {#if recent.length === 0}
        <EmptyState icon={History} title={t('calls.mine.empty')} />
      {:else}
        <div class="list">
          {#each recent as call (call.id)}
            <CallListItem
              {call}
              perspective={actor.id}
              onselect={() => go('/calls')}
            />
          {/each}
        </div>
      {/if}
    </Card>

    <div class="stack">
      <Card
        title={t('calls.overview.voicemail')}
        icon={VoicemailIcon}
        padded={false}
      >
        {#snippet actions()}
          <Button
            size="sm"
            variant="ghost"
            iconRight={ArrowRight}
            href={href('/voicemail')}
            >{t('calls.overview.openVoicemail')}</Button
          >
        {/snippet}
        {#if unread.length === 0}
          <p class="quiet">
            <Sparkles size={16} />
            {t('calls.overview.voicemailClear')}
          </p>
        {:else}
          <ul class="rows">
            {#each unread.slice(0, 3) as vm (vm.id)}
              <li>
                <a href={href('/voicemail')} class="row-link">
                  <span class="unread-dot"></span>
                  <PartyLabel value={vm.caller} size={32} secondary="detail" />
                  <span class="right xs muted"
                    >{formatRelative(vm.createdAt)} · {formatDuration(
                      vm.durationS
                    )}</span
                  >
                </a>
              </li>
            {/each}
          </ul>
        {/if}
      </Card>

      {#if parked.length > 0}
        <Card
          title={t('calls.parking.now')}
          icon={SquareParking}
          padded={false}
        >
          <ul class="rows">
            {#each parked as entry (entry.slot)}
              <li class="parked">
                <span class="slot nums">{entry.slot}</span>
                <PartyLabel
                  value={entry.caller ?? 'anonymous'}
                  size={30}
                  secondary="none"
                />
                <span class="right">
                  <Button
                    size="sm"
                    variant="soft"
                    icon={Phone}
                    op="calls.originate"
                    onclick={() =>
                      run(
                        'calls.originate',
                        { target: entry.slot },
                        {
                          success: 'calls.parking.retrieved',
                          successParams: { slot: entry.slot }
                        }
                      )}>{t('calls.parking.retrieve')}</Button
                  >
                </span>
              </li>
            {/each}
          </ul>
        </Card>
      {/if}
    </div>
  </div>

  {#if admin}
    <h2 class="section">{t('calls.overview.system')}</h2>
    <div class="admin-grid block">
      <Card
        title={t('calls.overview.liveCalls')}
        icon={Activity}
        padded={false}
      >
        {#snippet actions()}
          <Button
            size="sm"
            variant="ghost"
            iconRight={ArrowRight}
            href={href('/live')}>{t('calls.overview.openLive')}</Button
          >
        {/snippet}
        {#if live.length === 0}
          <p class="quiet">{t('calls.live.empty')}</p>
        {:else}
          <ul class="rows">
            {#each live.slice(0, 4) as call (call.callId)}
              <li>
                <a class="row-link" href={href('/live')}>
                  <span
                    class="live-dot"
                    class:ringing={call.state === 'ringing'}
                  ></span>
                  <span class="grow truncate small"
                    ><span class="strong">{partyName(call.from)}</span> → {partyName(
                      call.to
                    )}</span
                  >
                  <span class="nums small strong"
                    >{formatDuration(secondsSince(call.startedAt))}</span
                  >
                </a>
              </li>
            {/each}
          </ul>
        {/if}
      </Card>

      <Card title={t('calls.overview.trunks')} icon={Cable}>
        <ul class="facts">
          {#each trunks as trunk (trunk.id)}
            <li>
              <a href={href(`/trunks/${trunk.id}`)} class="strong"
                >{trunk.name}</a
              >
              <Badge tone={TRUNK_TONE[trunk.status]} dot
                >{t(`trunk.status.${trunk.status}`)}</Badge
              >
            </li>
            {#if trunk.registeredAt && trunk.status === 'registered'}
              <li class="xs muted">
                {t('calls.overview.registeredSince', {
                  when: formatRelative(trunk.registeredAt)
                })}
              </li>
            {/if}
          {:else}
            <li class="muted small">{t('calls.overview.noTrunks')}</li>
          {/each}
        </ul>
      </Card>

      <Card title={t('calls.overview.health')} icon={Server}>
        <ul class="facts">
          {#if system}
            <li>
              <span>{t('calls.overview.version')}</span>
              <span class="mono small"
                >{isExpert() ? system.api.display : system.api.version}</span
              >
            </li>
            <li>
              <span>{t('calls.overview.updates')}</span>
              {#if system.update.latest && system.update.latest.version !== system.update.current}
                <a href={href('/system')}
                  ><Badge tone="lime"
                    >{t('calls.overview.updateAvailable', {
                      version: system.update.latest.version
                    })}</Badge
                  ></a
                >
              {:else}
                <Badge tone="ok" dot>{t('calls.overview.upToDate')}</Badge>
              {/if}
            </li>
          {/if}
          <li>
            <span class="row" style="--gap: 6px"
              ><DatabaseBackup size={14} /> {t('calls.overview.backups')}</span
            >
            <a href={href('/backups')}
              ><Badge tone={backupsOk ? 'ok' : 'danger'} dot
                >{backupsOk
                  ? t('calls.overview.backupsOk')
                  : t('calls.overview.backupsFailed')}</Badge
              ></a
            >
          </li>
          {#each lastRuns as entry (entry.target.id)}
            <li class="xs muted">
              <span>{entry.target.kind.toUpperCase()}</span>
              <span
                >{entry.run
                  ? formatRelative(entry.run.finishedAt ?? entry.run.startedAt)
                  : '—'}</span
              >
            </li>
          {/each}
        </ul>
      </Card>
    </div>

    <Card title={t('calls.overview.volumeToday')} icon={ChartColumn}>
      {#snippet actions()}
        <span class="small muted"
          >{t('calls.overview.volumeSummary', {
            count: formatNumber(callsToday),
            rate: rate === null ? '—' : `${Math.round(rate * 100)} %`
          })}</span
        >
        <Button
          size="sm"
          variant="ghost"
          iconRight={ArrowRight}
          href={href('/stats')}>{t('calls.overview.openStats')}</Button
        >
      {/snippet}
      <TimeChart
        buckets={volume}
        kind="bar"
        height={150}
        format={value => formatNumber(Math.round(value))}
        tick={start => `${HOUR_FMT.format(new Date(start))}`}
        long={start =>
          t('calls.overview.hourOf', {
            hour: HOUR_FMT.format(new Date(start))
          })}
        label={t('calls.overview.volumeToday')}
      />
    </Card>
  {/if}
</div>

<style>
  .overview {
    container: overview / inline-size;
  }
  /* Unclipped, so the dial box's suggestions can reach past it; the decoration clips itself. */
  .hero {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
    gap: var(--space-5);
    align-items: center;
    padding: var(--space-6);
    border-radius: var(--radius-lg);
    background: var(--primary);
    color: var(--on-primary);
    box-shadow: var(--shadow-primary);
    margin-bottom: var(--space-5);
  }
  .deco-clip {
    position: absolute;
    inset: 0;
    overflow: hidden;
    border-radius: inherit;
    pointer-events: none;
  }
  .deco {
    position: absolute;
    right: -40px;
    top: -30px;
    width: 300px;
    height: 300px;
    pointer-events: none;
  }
  .deco circle {
    fill: var(--lime);
    opacity: 0.18;
  }
  .hello,
  .dial-panel {
    position: relative;
    z-index: 1;
  }
  .date {
    font-size: var(--text-sm);
    font-weight: 700;
    opacity: 0.8;
    text-transform: capitalize;
  }
  h1 {
    font-size: clamp(28px, 4vw, 42px);
    margin: 4px 0 var(--space-4);
  }
  .presence-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .presence-note {
    font-size: var(--text-sm);
    opacity: 0.85;
  }
  .on-call {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-4);
    padding: 8px 14px;
    border-radius: var(--radius-pill);
    background: var(--lime);
    color: var(--on-lime);
    font-weight: 700;
    font-size: var(--text-sm);
  }
  .pulse {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--on-lime);
    animation: blink 1.2s ease-in-out infinite;
  }
  @keyframes blink {
    50% {
      opacity: 0.25;
    }
  }
  .dial-panel {
    background: var(--surface);
    color: var(--text);
    border-radius: var(--radius-md);
    padding: var(--space-4);
    box-shadow: var(--shadow-lg);
  }
  .dial-title {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-lg);
    margin-bottom: var(--space-3);
    color: var(--primary);
  }
  .tiles {
    display: grid;
    gap: var(--space-3);
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr));
    margin-bottom: var(--space-5);
  }
  .block {
    margin-bottom: var(--space-5);
  }
  .list {
    padding: var(--space-2);
    display: grid;
    gap: 2px;
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: var(--space-2);
    display: grid;
    gap: 2px;
  }
  .rows li {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .rows li.parked {
    padding: 6px var(--space-3);
  }
  .row-link {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: 8px var(--space-3);
    border-radius: var(--radius-sm);
    color: var(--text);
  }
  .row-link:hover {
    background: var(--surface-2);
    text-decoration: none;
  }
  .right {
    margin-left: auto;
    flex: none;
  }
  .unread-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--primary);
    flex: none;
  }
  .quiet {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-4) var(--space-5);
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  .slot {
    display: grid;
    place-items: center;
    min-width: 44px;
    height: 34px;
    border-radius: var(--radius-sm);
    background: var(--primary);
    color: var(--on-primary);
    font-family: var(--font-display);
    font-weight: 800;
  }
  .section {
    margin: var(--space-2) 0 var(--space-3);
  }
  .admin-grid {
    display: grid;
    gap: var(--space-4);
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr));
  }
  .live-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--ok);
    flex: none;
  }
  .live-dot.ringing {
    background: var(--warn);
    animation: blink 1s ease-in-out infinite;
  }
  .facts {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-2);
  }
  .facts li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-2);
  }
  @container overview (max-width: 780px) {
    .hero {
      grid-template-columns: minmax(0, 1fr);
      padding: var(--space-5);
    }
  }
  @container overview (max-width: 520px) {
    .hero {
      padding: var(--space-4);
      border-radius: var(--radius-md);
    }
    .deco {
      width: 200px;
      height: 200px;
    }
  }
</style>
