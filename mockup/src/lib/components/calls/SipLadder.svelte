<!--
  A call's SIP messages (§7 level `sip`) as a ladder between the stack and the far end: each
  message its capture time to the millisecond, the time since the one before, and an arrow with
  its first line; a click unfolds the headers and body.
-->
<script lang="ts">
  import type { SipMessage } from '#lib/api/types.js';
  import {
    formatDuration,
    formatNumber,
    i18n,
    t
  } from '#lib/i18n/index.svelte.js';

  let { messages, far }: { messages: SipMessage[]; far: string } = $props();

  const MS_PER_SECOND = 1000;
  const MS_PER_MINUTE = 60_000;

  const clock = $derived(
    new Intl.DateTimeFormat(i18n.locale === 'de' ? 'de-DE' : 'en-GB', {
      timeZone: 'Europe/Berlin',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
      hourCycle: 'h23'
    })
  );

  function gap(ms: number): string {
    if (ms < MS_PER_SECOND) {
      return `+${formatNumber(ms)} ms`;
    }
    return ms < MS_PER_MINUTE
      ? `+${formatNumber(Math.round(ms / 100) / 10)} s`
      : `+${formatDuration(Math.round(ms / MS_PER_SECOND))}`;
  }

  const rows = $derived(
    messages.map((message, index) => {
      const at = new Date(message.at).getTime();
      const before = messages[index - 1];
      const [first = '', ...rest] = message.raw.split('\n');
      return {
        key: index,
        outbound: message.direction === 'out',
        time: clock.format(at),
        gap:
          before === undefined ? null : gap(at - new Date(before.at).getTime()),
        first,
        rest: rest.join('\n')
      };
    })
  );
</script>

<div class="ladder" role="list" aria-label={t('calls.sip.title')}>
  <div class="row" aria-hidden="true">
    <span></span>
    <div class="ends">
      <span>Zamfono</span>
      <span>{far}</span>
    </div>
  </div>
  {#each rows as row (row.key)}
    <div class="row msg" class:in={!row.outbound} role="listitem">
      <span class="when nums">
        <time>{row.time}</time>
        {#if row.gap}<span class="gap">{row.gap}</span>{/if}
      </span>
      <div class="flow">
        <span class="sr-only"
          >{row.outbound ? t('calls.sip.sent') : t('calls.sip.received')}</span
        >
        {#if row.rest}
          <details>
            <summary
              ><span class="arrow"></span><code class="first">{row.first}</code
              ></summary
            >
            <pre>{row.rest}</pre>
          </details>
        {:else}
          <div class="plain">
            <span class="arrow"></span><code class="first">{row.first}</code>
          </div>
        {/if}
      </div>
    </div>
  {/each}
</div>

<style>
  .ladder {
    display: grid;
  }
  .row {
    display: grid;
    grid-template-columns: 7.5em minmax(0, 1fr);
    column-gap: var(--space-2);
  }
  .when {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    padding-top: 4px;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-muted);
    white-space: nowrap;
  }
  .gap {
    color: var(--text-faint);
  }
  /* The two ends' lifelines, unbroken from row to row. */
  /* Positioned, so the screen-reader label stays inside its row. */
  .flow {
    position: relative;
    min-width: 0;
    padding: 2px var(--space-2) 4px;
    background:
      linear-gradient(var(--line-strong), var(--line-strong)) left 14px top /
        2px 100% no-repeat,
      linear-gradient(var(--line-strong), var(--line-strong)) right 14px top /
        2px 100% no-repeat;
  }
  .ends {
    padding: 0 var(--space-2);
    display: flex;
    justify-content: space-between;
    font-size: var(--text-xs);
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 4px;
  }
  .msg {
    padding: 0 var(--space-5);
  }
  summary,
  .plain {
    list-style: none;
    display: flex;
    flex-direction: column;
    cursor: pointer;
    gap: 2px;
  }
  .plain {
    cursor: default;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  .first {
    font-size: var(--text-xs);
    color: var(--text);
    text-align: center;
    word-break: break-all;
  }
  .arrow {
    order: 2;
    position: relative;
    height: 2px;
    background: var(--primary);
    margin: 2px 0 4px;
  }
  .arrow::after {
    content: '';
    position: absolute;
    right: -1px;
    top: -4px;
    border: 5px solid transparent;
    border-left: 7px solid var(--primary);
    border-right: 0;
  }
  .in .arrow {
    background: var(--info);
  }
  .in .arrow::after {
    right: auto;
    left: -1px;
    border-left: 0;
    border-right: 7px solid var(--info);
  }
  pre {
    margin: 4px 0 8px;
    padding: var(--space-2) var(--space-3);
    background: var(--surface-3);
    border-radius: var(--radius-xs);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    white-space: pre-wrap;
    word-break: break-all;
  }
</style>
