<!--
  The avatar menu: own settings, the security page, sign out.
-->
<script lang="ts">
  import Languages from '@lucide/svelte/icons/languages';
  import LogOut from '@lucide/svelte/icons/log-out';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import SunMoon from '@lucide/svelte/icons/sun-moon';
  import UserCog from '@lucide/svelte/icons/user-cog';
  import type { Snippet } from 'svelte';

  import { userById } from '#lib/api/lookup.js';
  import { t } from '#lib/i18n/index.svelte.js';
  import { go } from '#lib/state/router.svelte.js';
  import {
    currentActor,
    session,
    setLocale,
    setTheme,
    signOut
  } from '#lib/state/session.svelte.js';
  import RoleChip from '#lib/ui/RoleChip.svelte';
  import Segmented from '#lib/ui/Segmented.svelte';

  let { children }: { children: Snippet } = $props();
  let open = $state(false);
  let root = $state<HTMLDivElement>();
  const actor = $derived(currentActor());
  const me = $derived(userById(actor.id));
</script>

<svelte:window
  onclick={event => {
    if (open && root && !root.contains(event.target as Node)) {
      open = false;
    }
  }}
/>

<div class="account" bind:this={root}>
  <button
    type="button"
    class="trigger"
    aria-label={t('account.menu')}
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    {@render children()}
  </button>
  {#if open}
    <div class="panel">
      <div class="who">
        <strong>{me?.name}</strong>
        <span class="xs muted">{me?.email ?? t('account.noEmail')}</span>
        <RoleChip role={actor.role} />
      </div>
      <button
        type="button"
        onclick={() => {
          open = false;
          go('/me/profile');
        }}><UserCog size={16} /> {t('nav.me')}</button
      >
      <button
        type="button"
        onclick={() => {
          open = false;
          go('/me/security');
        }}><ShieldCheck size={16} /> {t('account.security')}</button
      >
      <div class="prefs">
        <div class="pref">
          <span class="pref-label"
            ><Languages size={16} /> {t('account.language')}</span
          >
          <Segmented
            size="sm"
            value={session.locale}
            options={[
              { value: 'de', label: 'DE' },
              { value: 'en', label: 'EN' }
            ]}
            onchange={setLocale}
            ariaLabel={t('account.language')}
          />
        </div>
        <div class="pref">
          <span class="pref-label"
            ><SunMoon size={16} /> {t('account.theme')}</span
          >
          <Segmented
            size="sm"
            value={session.theme}
            options={[
              { value: 'system', label: t('account.themeSystem') },
              { value: 'light', label: t('account.themeLight') },
              { value: 'dark', label: t('account.themeDark') }
            ]}
            onchange={setTheme}
            ariaLabel={t('account.theme')}
          />
        </div>
      </div>
      <button
        type="button"
        class="danger"
        onclick={() => {
          open = false;
          signOut();
          go('/auth/signin');
        }}><LogOut size={16} /> {t('account.signOut')}</button
      >
    </div>
  {/if}
</div>

<style>
  .account {
    position: relative;
  }
  .trigger {
    border: 0;
    background: transparent;
    padding: 0;
    border-radius: 50%;
    cursor: pointer;
    display: grid;
  }
  .panel {
    position: absolute;
    right: 0;
    top: calc(100% + 8px);
    width: 300px;
    max-width: calc(100vw - 16px);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    padding: 6px;
    z-index: 60;
  }
  .who {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: 10px 12px 12px;
    border-bottom: 1px solid var(--line);
    margin-bottom: 4px;
  }
  .panel > button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 9px 12px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    cursor: pointer;
    font-weight: 500;
    text-align: left;
    color: var(--text);
  }
  .panel > button:hover {
    background: var(--surface-3);
  }
  .prefs {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 12px 10px;
    margin: 4px 0;
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
  }
  .pref {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  .pref-label {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: var(--text-sm);
    font-weight: 500;
  }
  .danger {
    color: var(--danger) !important;
  }
</style>
