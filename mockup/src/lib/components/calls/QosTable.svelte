<!--
  Call quality per leg (§7 level `qos`): jitter, packet loss, round trip and the packets received
  and sent, each rated good, fair or poor. No packets received on a leg means its audio never
  arrived (NAT, a blocked RTP port).
-->
<script lang="ts">
  import type { CallQos } from '#lib/api/types.js';
  import { formatNumber, t } from '#lib/i18n/index.svelte.js';
  import { isExpert } from '#lib/state/session.svelte.js';

  let { qos }: { qos: CallQos[] } = $props();

  type Rating = 'good' | 'fair' | 'poor' | 'none';

  function rate(value: number | null, fair: number, poor: number): Rating {
    if (value === null) {
      return 'none';
    }
    return value >= poor ? 'poor' : value >= fair ? 'fair' : 'good';
  }

  const rows = $derived(
    qos.map(leg => ({
      leg,
      jitter: rate(leg.jitterMs, 20, 40),
      loss: rate(leg.lossPct, 1, 3),
      rtt: rate(leg.rttMs, 150, 300),
      rx: (leg.rxPackets === 0
        ? 'poor'
        : leg.rxPackets === null
          ? 'none'
          : 'good') as Rating
    }))
  );
  const overall = $derived.by((): Rating => {
    const all = rows.flatMap(row => [row.jitter, row.loss, row.rtt, row.rx]);
    if (all.includes('poor')) {
      return 'poor';
    }
    return all.includes('fair') ? 'fair' : all.length > 0 ? 'good' : 'none';
  });
  const fmt = (value: number | null, unit: string): string =>
    value === null ? '—' : `${formatNumber(value)} ${unit}`;
</script>

<div class="qos">
  <p class="verdict {overall}">
    <span class="dot"></span>
    {t(`calls.qos.verdict.${overall}`)}
  </p>
  <div class="legs">
    {#each rows as row (row.leg.channelId)}
      <div class="leg">
        <div class="leg-head">
          <span class="strong">{t(`calls.qos.role.${row.leg.role}`)}</span>
          {#if isExpert()}<code class="xs faint">{row.leg.channelId}</code>{/if}
        </div>
        <dl>
          <div class="metric {row.jitter}">
            <dt>{t('calls.qos.jitter')}</dt>
            <dd class="nums">{fmt(row.leg.jitterMs, 'ms')}</dd>
          </div>
          <div class="metric {row.loss}">
            <dt>{t('calls.qos.loss')}</dt>
            <dd class="nums">{fmt(row.leg.lossPct, '%')}</dd>
          </div>
          <div class="metric {row.rtt}">
            <dt>{t('calls.qos.rtt')}</dt>
            <dd class="nums">{fmt(row.leg.rttMs, 'ms')}</dd>
          </div>
          <div class="metric {row.rx}">
            <dt>{t('calls.qos.packets')}</dt>
            <dd class="nums">
              {row.leg.rxPackets === null
                ? '—'
                : formatNumber(row.leg.rxPackets)} / {row.leg.txPackets === null
                ? '—'
                : formatNumber(row.leg.txPackets)}
            </dd>
          </div>
        </dl>
        {#if row.leg.rxPackets === 0}<p class="warning small">
            {t('calls.qos.noAudio')}
          </p>{/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .qos {
    display: grid;
    gap: var(--space-3);
  }
  .verdict {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-weight: 700;
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--text-faint);
  }
  .verdict.good .dot {
    background: var(--ok);
  }
  .verdict.fair .dot {
    background: var(--warn);
  }
  .verdict.poor .dot {
    background: var(--danger);
  }
  .legs {
    display: grid;
    gap: var(--space-3);
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
  }
  .leg {
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: var(--space-3);
    background: var(--surface-2);
  }
  .leg-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
  }
  dl {
    margin: 0;
    display: grid;
    gap: 6px;
  }
  .metric {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
  }
  dt {
    color: var(--text-muted);
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  dt::before {
    content: '';
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-faint);
  }
  .good dt::before {
    background: var(--ok);
  }
  .fair dt::before {
    background: var(--warn);
  }
  .poor dt::before {
    background: var(--danger);
  }
  dd {
    margin: 0;
    font-weight: 700;
  }
  .fair dd {
    color: var(--warn);
  }
  .poor dd {
    color: var(--danger);
  }
  .warning {
    color: var(--danger);
    margin-top: var(--space-2);
  }
</style>
