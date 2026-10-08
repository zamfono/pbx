<!--
  The demo bar: visibly not part of the product. Switch persona, pause the simulator, reset the
  demo, sign out.
-->
<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ChevronUp from '@lucide/svelte/icons/chevron-up';
  import LogOut from '@lucide/svelte/icons/log-out';
  import Pause from '@lucide/svelte/icons/pause';
  import Play from '@lucide/svelte/icons/play';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Sparkles from '@lucide/svelte/icons/sparkles';

  import { userById } from '#lib/api/lookup.js';
  import { PERSONAS } from '#lib/api/seed/ids.js';
  import { clock, setMoment } from '#lib/clock.svelte.js';
  import { t } from '#lib/i18n/index.svelte.js';
  import { resetDemo } from '#lib/state/demo.js';
  import { go } from '#lib/state/router.svelte.js';
  import {
    savePrefs,
    session,
    signOut,
    switchPersona
  } from '#lib/state/session.svelte.js';
  import { confirmDialog } from '#lib/state/ui.svelte.js';

  import DemoClock from './DemoClock.svelte';
</script>

<div class="demo" class:collapsed={session.demoBarCollapsed}>
  {#if session.demoBarCollapsed}
    <button
      type="button"
      class="expand"
      onclick={() => {
        session.demoBarCollapsed = false;
        savePrefs();
      }}
    >
      <Sparkles size={12} />
      {t('demo.label')}
      <ChevronDown size={12} />
    </button>
  {:else}
    <span class="label"
      ><Sparkles size={13} />
      <span class="label-text">{t('demo.label')}</span></span
    >
    <div class="personas" role="radiogroup" aria-label={t('demo.persona')}>
      {#each PERSONAS as persona (persona.key)}
        {@const user = userById(persona.userId)}
        <button
          type="button"
          role="radio"
          aria-checked={session.persona === persona.key}
          class:on={session.persona === persona.key}
          onclick={() => {
            switchPersona(persona.key);
            go('/overview');
          }}
        >
          <span class="name">{user?.name.split(' ')[0]}</span>
          <span class="role">{t(`role.${user?.role ?? 'user'}`)}</span>
        </button>
      {/each}
    </div>
    <DemoClock />
    <div class="spacer"></div>
    <button
      type="button"
      class="ctl"
      title={session.simulatorPaused ? t('demo.resume') : t('demo.pause')}
      aria-label={session.simulatorPaused ? t('demo.resume') : t('demo.pause')}
      onclick={() => {
        session.simulatorPaused = !session.simulatorPaused;
        savePrefs();
      }}
    >
      {#if session.simulatorPaused}<Play size={13} />{:else}<Pause
          size={13}
        />{/if}
      <span class="hide-sm"
        >{session.simulatorPaused ? t('demo.resume') : t('demo.pause')}</span
      >
    </button>
    <button
      type="button"
      class="ctl"
      title={t('demo.reset.action')}
      aria-label={t('demo.reset.action')}
      onclick={async () => {
        if (
          await confirmDialog({
            title: t('demo.reset.title'),
            body: t('demo.reset.body'),
            confirmLabel: t('demo.reset.action'),
            cancelLabel: t('common.cancel'),
            tone: 'danger',
            note: null
          })
        ) {
          setMoment(clock.moment);
          resetDemo();
          go('/overview');
        }
      }}
    >
      <RotateCcw size={13} />
      <span class="hide-sm">{t('demo.reset.action')}</span>
    </button>
    <button
      type="button"
      class="ctl"
      title={t('demo.signOut')}
      aria-label={t('demo.signOut')}
      onclick={() => {
        signOut();
        go('/auth/signin');
      }}
    >
      <LogOut size={13} /> <span class="hide-sm">{t('demo.signOut')}</span>
    </button>
    <button
      type="button"
      class="ctl icon"
      aria-label={t('demo.collapse')}
      onclick={() => {
        session.demoBarCollapsed = true;
        savePrefs();
      }}
    >
      <ChevronUp size={14} />
    </button>
  {/if}
</div>

<style>
  .demo {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    height: var(--demobar-height);
    padding: 0 var(--space-4);
    background: var(--demo-bg);
    color: var(--demo-text);
    font-size: 12px;
    flex: none;
    overflow-x: auto;
    scrollbar-width: none;
    background-image: repeating-linear-gradient(
      -45deg,
      transparent 0 12px,
      rgb(255 255 255 / 3%) 12px 24px
    );
  }
  .collapsed {
    height: 0;
    padding: 0;
    overflow: visible;
    position: relative;
    z-index: 30;
  }
  .expand {
    position: absolute;
    left: 50%;
    top: 0;
    transform: translateX(-50%);
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 0;
    border-radius: 0 0 10px 10px;
    padding: 2px 10px 4px;
    background: var(--demo-bg);
    color: var(--demo-accent);
    font-weight: 800;
    font-size: 11px;
    cursor: pointer;
  }
  .label {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--demo-accent);
    font-weight: 800;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .personas {
    display: flex;
    gap: 4px;
  }
  .personas button {
    display: inline-flex;
    align-items: baseline;
    gap: 5px;
    border: 1px solid rgb(255 255 255 / 15%);
    background: transparent;
    color: inherit;
    border-radius: var(--radius-pill);
    padding: 3px 10px;
    cursor: pointer;
    white-space: nowrap;
  }
  .personas button.on {
    background: var(--demo-accent);
    color: var(--on-lime);
    border-color: transparent;
  }
  .name {
    font-weight: 800;
  }
  .role {
    opacity: 0.7;
    font-size: 11px;
  }
  .spacer {
    flex: 1;
  }
  .ctl {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 0;
    background: rgb(255 255 255 / 8%);
    color: inherit;
    border-radius: var(--radius-pill);
    padding: 4px 10px;
    cursor: pointer;
    white-space: nowrap;
    font-weight: 700;
  }
  .ctl:hover {
    background: rgb(255 255 255 / 16%);
  }
  .ctl.icon {
    padding: 4px 6px;
  }
  @media (max-width: 1000px) {
    .hide-sm {
      display: none;
    }
    .ctl {
      padding: 4px 8px;
    }
  }
  @media (max-width: 900px) {
    .role {
      display: none;
    }
  }
  @media (max-width: 420px) {
    .label-text {
      display: none;
    }
    .demo {
      gap: var(--space-2);
      padding: 0 var(--space-3);
    }
  }
</style>
