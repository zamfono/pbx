<!--
  The phone's bottom tab bar: the self-service pages and Mucki.
-->
<script lang="ts">
  import Bot from '@lucide/svelte/icons/bot';

  import { t } from '#lib/i18n/index.svelte.js';
  import { pageAt, PAGES } from '#lib/nav.js';
  import { href, router } from '#lib/state/router.svelte.js';
  import { session } from '#lib/state/session.svelte.js';

  const tabs = PAGES.filter(page => page.tab === true);
  const activeId = $derived(pageAt(router.route.path)?.id);
</script>

<nav class="tabbar" aria-label={t('nav.tabs')}>
  {#each tabs as page (page.id)}
    {@const Glyph = page.icon}
    {@const base = page.patterns[0]?.split('/:')[0] ?? '/'}
    <a href={href(base)} class:on={page.id === activeId}>
      <Glyph size={21} />
      <span>{t(`${page.label}.short`)}</span>
    </a>
  {/each}
  <button
    type="button"
    class="mucki"
    class:on={session.muckiOpen}
    onclick={() => (session.muckiOpen = !session.muckiOpen)}
  >
    <Bot size={21} />
    <span>Mucki</span>
  </button>
</nav>

<style>
  .tabbar {
    display: none;
  }
  @media (max-width: 760px) {
    .tabbar {
      display: flex;
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 80;
      height: calc(var(--tabbar-height) + env(safe-area-inset-bottom));
      padding-bottom: env(safe-area-inset-bottom);
      background: var(--surface);
      border-top: 1px solid var(--line);
      box-shadow: 0 -6px 20px rgb(0 0 0 / 6%);
    }
    a,
    button {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 3px;
      border: 0;
      background: transparent;
      color: var(--text-muted);
      font-size: 10.5px;
      font-weight: 700;
      text-decoration: none;
      cursor: pointer;
    }
    a.on {
      color: var(--primary);
    }
    .mucki {
      color: var(--mucki);
    }
    .mucki.on {
      color: var(--mucki-text);
    }
  }
</style>
