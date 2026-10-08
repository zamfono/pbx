<!--
  The event bell: the latest realtime events (§10.6) this person receives, as words.
-->
<script lang="ts">
  import Bell from '@lucide/svelte/icons/bell';

  import { visibleTo } from '#lib/api/events.svelte.js';
  import { ringGroupById, trunkById, userById } from '#lib/api/lookup.js';
  import { store } from '#lib/api/store.svelte.js';
  import type { Envelope } from '#lib/api/types.js';
  import { nowDate as demoNowDate } from '#lib/clock.svelte.js';
  import { formatPhone, formatRelative, t } from '#lib/i18n/index.svelte.js';
  import { currentActor, isExpert } from '#lib/state/session.svelte.js';

  let open = $state(false);
  let seenAt = $state(demoNowDate().toISOString());
  let root = $state<HTMLDivElement>();

  const actor = $derived(currentActor());
  const events = $derived(
    store.db.events
      .filter(event => visibleTo(store.db, event, actor.role, actor.id))
      .slice(0, 30)
  );
  const unseen = $derived(events.filter(event => event.at > seenAt).length);

  function describe(event: Envelope): string {
    switch (event.type) {
      case 'presence':
        return t('events.presence', {
          name: userById(event.userId)?.name ?? '',
          status: t(`presence.${event.status}`)
        });
      case 'call.state':
        return t(`events.call.${event.state}`, {
          peer: formatPhone(event.peer),
          group: ringGroupById(event.ringGroupId)?.name ?? ''
        });
      case 'voicemail.new':
        return t('events.voicemail', {
          mailbox:
            event.mailbox.kind === 'user'
              ? (userById(event.mailbox.userId)?.name ?? '')
              : (ringGroupById(event.mailbox.ringGroupId)?.name ?? '')
        });
      case 'ooo':
        return t(event.active ? 'events.oooOn' : 'events.oooOff');
      case 'hours':
        return t(event.open ? 'events.hoursOpen' : 'events.hoursClosed');
      case 'trunk.status':
        return t('events.trunk', {
          name: trunkById(event.trunkId)?.name ?? '',
          status: t(`trunk.status.${event.status}`)
        });
      case 'sipBan.added':
        return t('events.sipBan', { address: event.address });
      case 'history.appended':
        return t('events.history');
      case 'backup.started':
        return t('events.backupStarted');
      case 'backup.finished':
        return t('events.backupFinished');
      case 'backup.failed':
        return t('events.backupFailed', { error: event.error });
    }
  }
</script>

<svelte:window
  onclick={event => {
    if (open && root && !root.contains(event.target as Node)) {
      open = false;
    }
  }}
/>

<div class="bell" bind:this={root}>
  <button
    type="button"
    class="tool"
    aria-label={t('events.title')}
    aria-expanded={open}
    onclick={() => {
      open = !open;
      if (!open) {
        seenAt = demoNowDate().toISOString();
      }
    }}
  >
    <Bell size={18} />
    {#if unseen > 0}<span class="count">{unseen > 9 ? '9+' : unseen}</span>{/if}
  </button>
  {#if open}
    <div class="panel">
      <header>
        <strong>{t('events.title')}</strong>
        <span class="xs muted">{t('events.subtitle')}</span>
      </header>
      {#if events.length === 0}
        <p class="empty">{t('events.empty')}</p>
      {:else}
        <ul>
          {#each events as event (event.id)}
            <li class:new={event.at > seenAt}>
              <span class="what">{describe(event)}</span>
              <span class="when"
                >{formatRelative(event.at)}{#if isExpert()}
                  · <code>{event.type}</code>{/if}</span
              >
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  .bell {
    position: relative;
  }
  .tool {
    position: relative;
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
  }
  .tool:hover {
    background: var(--surface-3);
    color: var(--text);
  }
  .count {
    position: absolute;
    top: 3px;
    right: 2px;
    min-width: 17px;
    height: 17px;
    padding: 0 4px;
    border-radius: var(--radius-pill);
    background: var(--mucki);
    color: #fff;
    font-size: 10px;
    font-weight: 800;
    display: grid;
    place-items: center;
    box-shadow: 0 0 0 2px var(--surface);
  }
  .panel {
    position: absolute;
    right: 0;
    top: calc(100% + 8px);
    width: min(380px, calc(100vw - 24px));
    max-height: 70vh;
    overflow-y: auto;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    z-index: 60;
  }
  header {
    display: flex;
    flex-direction: column;
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--line);
    position: sticky;
    top: 0;
    background: var(--surface);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 4px;
  }
  li {
    display: flex;
    flex-direction: column;
    padding: 8px 12px;
    border-radius: var(--radius-sm);
  }
  li.new {
    background: var(--primary-soft);
  }
  .what {
    font-size: var(--text-sm);
    font-weight: 500;
  }
  .when {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .empty {
    padding: var(--space-4);
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  @media (max-width: 760px) {
    .panel {
      position: fixed;
      right: 12px;
      top: calc(var(--topbar-height) + var(--demobar-height));
    }
  }
</style>
