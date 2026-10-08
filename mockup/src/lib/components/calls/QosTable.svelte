<!--
  Call quality per leg (§7 level `qos`), rated good, fair or poor. Expert mode shows the measures
  behind each rating: jitter, packet loss, round trip and the packets received and sent. No packets
  received on a leg means its audio never arrived (NAT, a blocked RTP port).
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

  /** The worst of `ratings`, ignoring missing measures. */
  function worst(ratings: Rating[]): Rating {
    if (ratings.includes('poor')) {
      return 'poor';
    }
    if (ratings.includes('fair')) {
      return 'fair';
    }
    return ratings.includes('good') ? 'good' : 'none';
  }

  const rows = $derived(
    qos.map(leg => {
      const jitter = rate(leg.jitterMs, 20, 40);
      const loss = rate(leg.lossPct, 1, 3);
      const rtt = rate(leg.rttMs, 150, 300);
      const rx: Rating =
        leg.rxPackets === 0 ? 'poor' : leg.rxPackets === null ? 'none' : 'good';
      return {
        leg,
        jitter,
        loss,
        rtt,
        rx,
        side: worst([jitter, loss, rtt, rx])
      };
    })
  );
  const overall = $derived(worst(rows.map(row => row.side)));
  /** Outside Expert mode the sides show only where they tell more than the verdict. */
  const sidesShown = $derived(
    isExpert() ||
      rows.some(row => row.side !== overall || row.leg.rxPackets === 0)
  );
  const fmt = (value: number | null, unit: string): string =>
    value === null ? '—' : `${formatNumber(value)} ${unit}`;
</script>

<div class="qos">
  <p class="verdict {overall}">
    <span class="dot"></span>
    {t(`calls.qos.verdict.${overall}`)}
  </p>
  {#if sidesShown}<div class="legs">
      {#each rows as row (row.leg.channelId)}
        <div class="leg">
          <div class="leg-head">
            <span class="strong">{t(`calls.qos.role.${row.leg.role}`)}</span>
            {#if isExpert()}<code class="xs faint">{row.leg.channelId}</code
              >{/if}
          </div>
          {#if isExpert()}<dl>
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
                    : formatNumber(row.leg.rxPackets)} / {row.leg.txPackets ===
                  null
                    ? '—'
                    : formatNumber(row.leg.txPackets)}
                </dd>
              </div>
            </dl>
          {:else}<p class="side {row.side}">
              {t(`calls.qos.verdict.${row.side}`)}
            </p>{/if}
          {#if row.leg.rxPackets === 0}<p class="warning small">
              {t('calls.qos.noAudio')}{#if isExpert()}
                {t('calls.qos.noAudioCause')}{/if}
            </p>{/if}
        </div>
      {/each}
    </div>{/if}
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
  dt,
  .side {
    color: var(--text-muted);
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .side {
    margin: 0;
    font-size: var(--text-sm);
  }
  dt::before,
  .side::before {
    content: '';
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-faint);
  }
  .good dt::before,
  .side.good::before {
    background: var(--ok);
  }
  .fair dt::before,
  .side.fair::before {
    background: var(--warn);
  }
  .poor dt::before,
  .side.poor::before {
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
