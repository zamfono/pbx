<!--
  A call's SIP messages (§7 level `sip`) as a ladder between the stack and the far end: each
  message an arrow with its first line; a click unfolds the headers.
-->
<script lang="ts">
  import { t } from '#lib/i18n/index.svelte.js';

  let { messages, far }: { messages: string[]; far: string } = $props();

  const rows = $derived(
    messages.map((raw, index) => {
      const outbound = raw.startsWith('→');
      const body = raw.replace(/^[→←]\s*/u, '');
      const [first = '', ...rest] = body.split('\n');
      return { key: index, outbound, first, rest: rest.join('\n') };
    })
  );
</script>

<div class="ladder" role="list" aria-label={t('calls.sip.title')}>
  <div class="ends" aria-hidden="true">
    <span>Zamfono</span>
    <span>{far}</span>
  </div>
  {#each rows as row (row.key)}
    <div class="msg" class:in={!row.outbound} role="listitem">
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
  {/each}
</div>

<style>
  .ladder {
    position: relative;
    display: grid;
    gap: 4px;
    padding: 0 var(--space-2);
    background:
      linear-gradient(var(--line-strong), var(--line-strong)) left 14px top
        28px / 2px calc(100% - 28px) no-repeat,
      linear-gradient(var(--line-strong), var(--line-strong)) right 14px top
        28px / 2px calc(100% - 28px) no-repeat;
  }
  .ends {
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
