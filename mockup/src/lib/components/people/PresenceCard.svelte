<!--
  The person's own presence and do-not-disturb switch (`users.setPresence`, outside the audit
  log). While DND is on, calls follow the `dnd` forwarding rule, else the mailbox, else busy.
-->
<script lang="ts">
  import BellOff from '@lucide/svelte/icons/bell-off';
  import BellRing from '@lucide/svelte/icons/bell-ring';

  import { run } from '#lib/actions.svelte.js';
  import { presenceOf } from '#lib/api/lookup.js';
  import { store } from '#lib/api/store.svelte.js';
  import type { User } from '#lib/api/types.js';
  import { t } from '#lib/i18n/index.svelte.js';
  import Presence from '#lib/ui/Presence.svelte';

  let { user }: { user: User } = $props();

  const status = $derived(presenceOf(user.id));
  const dndCode = $derived(
    user.dnd
      ? store.db.settings.featureCodes.dndOff
      : store.db.settings.featureCodes.dndOn
  );
  let busy = $state(false);

  async function toggle(): Promise<void> {
    busy = true;
    await run(
      'users.setPresence',
      { id: user.id, dnd: !user.dnd },
      {
        success: user.dnd
          ? 'people.presence.dndOffDone'
          : 'people.presence.dndOnDone'
      }
    );
    busy = false;
  }
</script>

<section class="presence-card" class:dnd={user.dnd}>
  <div class="status">
    <span class="dot-wrap"><Presence {status} size={14} /></span>
    <div class="grow">
      <div class="xs muted strong caps">{t('people.presence.now')}</div>
      <div class="state">{t(`presence.${status}`)}</div>
    </div>
  </div>
  <button
    type="button"
    class="toggle"
    role="switch"
    aria-checked={user.dnd}
    disabled={busy || user.extension === null}
    onclick={toggle}
  >
    <span class="icon" aria-hidden="true">
      {#if user.dnd}<BellOff size={22} />{:else}<BellRing size={22} />{/if}
    </span>
    <span class="text">
      <span class="strong">{t('presence.dnd')}</span>
      <span class="small"
        >{user.dnd
          ? t('people.presence.dndOnHelp')
          : t('people.presence.dndOffHelp')}</span
      >
    </span>
    <span class="track" aria-hidden="true"><span class="thumb"></span></span>
  </button>
  <p class="xs muted code">
    {t('people.presence.byPhone', { code: dndCode })}
  </p>
</section>

<style>
  .presence-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-5);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-sm);
  }
  .presence-card.dnd {
    border-color: var(--danger);
    background: var(--danger-soft);
  }
  .status {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .dot-wrap {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--surface-3);
  }
  .caps {
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .state {
    font-family: var(--font-display);
    font-weight: 800;
    font-size: var(--text-xl);
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    min-height: 64px;
    padding: var(--space-3) var(--space-4);
    border: 1.5px solid var(--line-strong);
    border-radius: var(--radius-md);
    background: var(--surface);
    text-align: left;
    cursor: pointer;
  }
  .toggle:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .dnd .toggle {
    border-color: var(--danger);
  }
  .icon {
    display: grid;
    place-items: center;
    color: var(--text-muted);
  }
  .dnd .icon {
    color: var(--danger);
  }
  .text {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .text .small {
    color: var(--text-muted);
  }
  .track {
    width: 50px;
    height: 30px;
    border-radius: var(--radius-pill);
    background: var(--line-strong);
    position: relative;
    flex: none;
    transition: background 0.2s var(--ease);
  }
  .thumb {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--surface);
    box-shadow: var(--shadow-sm);
    transition: transform 0.2s var(--ease);
  }
  .dnd .track {
    background: var(--danger);
  }
  .dnd .thumb {
    transform: translateX(20px);
  }
  .code {
    margin: 0;
    display: flex;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: wrap;
  }
</style>
