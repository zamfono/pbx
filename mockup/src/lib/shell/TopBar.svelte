<!--
  The top bar: menu (phones), company, search (`search.query`), own presence with DND
  (`users.setPresence`), event bell, language, theme, Expert mode, Mucki, avatar menu.
-->
<script lang="ts">
  import Bot from '@lucide/svelte/icons/bot';
  import FlaskConical from '@lucide/svelte/icons/flask-conical';
  import Menu from '@lucide/svelte/icons/menu';
  import Monitor from '@lucide/svelte/icons/monitor';
  import Moon from '@lucide/svelte/icons/moon';
  import Search from '@lucide/svelte/icons/search';
  import Sun from '@lucide/svelte/icons/sun';
  import X from '@lucide/svelte/icons/x';

  import { presenceOf, userById } from '#lib/api/lookup.js';
  import { store } from '#lib/api/store.svelte.js';
  import { t } from '#lib/i18n/index.svelte.js';
  import {
    currentActor,
    isExpert,
    savePrefs,
    session,
    setExpert,
    setLocale,
    setTheme
  } from '#lib/state/session.svelte.js';
  import Avatar from '#lib/ui/Avatar.svelte';

  import AccountMenu from './AccountMenu.svelte';
  import EventBell from './EventBell.svelte';
  import Logo from './Logo.svelte';
  import PresenceToggle from './PresenceToggle.svelte';
  import SearchBox from './SearchBox.svelte';

  let { onmenu }: { onmenu: () => void } = $props();
  /** Below 1000 px the search is an icon that opens a full-width search row. */
  let searchOpen = $state(false);

  const actor = $derived(currentActor());
  const me = $derived(userById(actor.id));
  const themeIcon = $derived(
    session.theme === 'dark' ? Moon : session.theme === 'light' ? Sun : Monitor
  );
  const nextTheme = $derived(
    session.theme === 'system'
      ? 'light'
      : session.theme === 'light'
        ? 'dark'
        : 'system'
  );
</script>

<header class="topbar">
  <button
    type="button"
    class="menu-btn"
    aria-label={t('topbar.menu')}
    onclick={onmenu}><Menu size={20} /></button
  >
  <a class="brand" href="/overview">
    <Logo size={30} />
    <span class="brand-text">
      <span class="product">zamfono</span>
      <span class="company truncate">{store.db.settings.companyName}</span>
    </span>
  </a>

  <div class="search"><SearchBox /></div>

  <div class="tools">
    <button
      type="button"
      class="tool search-toggle"
      aria-label={t('common.search')}
      aria-expanded={searchOpen}
      onclick={() => (searchOpen = !searchOpen)}
    >
      {#if searchOpen}<X size={18} />{:else}<Search size={18} />{/if}
    </button>
    {#if me?.extension}
      <span class="presence-slot"
        ><PresenceToggle
          userId={actor.id}
          status={presenceOf(actor.id)}
          compact
        /></span
      >
    {/if}
    <EventBell />
    <button
      type="button"
      class="tool lang"
      aria-label={t('topbar.language')}
      title={t('topbar.language')}
      onclick={() => setLocale(session.locale === 'de' ? 'en' : 'de')}
    >
      {session.locale === 'de' ? 'DE' : 'EN'}
    </button>
    {#snippet themeGlyph()}
      {@const Glyph = themeIcon}
      <Glyph size={18} />
    {/snippet}
    <button
      type="button"
      class="tool theme"
      aria-label={t('topbar.theme', { theme: t(`theme.${session.theme}`) })}
      title={t('topbar.theme', { theme: t(`theme.${session.theme}`) })}
      onclick={() => setTheme(nextTheme)}
    >
      {@render themeGlyph()}
    </button>
    <button
      type="button"
      class="expert"
      class:on={isExpert()}
      aria-pressed={isExpert()}
      title={t('topbar.expertHelp')}
      onclick={() => setExpert(!isExpert())}
    >
      <FlaskConical size={15} />
      <span class="expert-label">{t('topbar.expert')}</span>
      <span class="sw" aria-hidden="true"><span></span></span>
    </button>
    {#if !session.muckiOpen}
      <button
        type="button"
        class="mucki"
        onclick={() => {
          session.muckiOpen = true;
          savePrefs();
        }}
      >
        <Bot size={17} /> <span class="mucki-label">Mucki</span>
      </button>
    {/if}
    <AccountMenu>
      <Avatar name={me?.name ?? '?'} size={34} />
    </AccountMenu>
  </div>
  {#if searchOpen}
    <div class="search-row">
      <SearchBox autofocus onpick={() => (searchOpen = false)} />
    </div>
  {/if}
</header>

<style>
  .topbar {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    height: var(--topbar-height);
    padding: 0 var(--space-4) 0 var(--space-5);
    background: var(--surface);
    border-bottom: 1px solid var(--line);
    flex: none;
    position: relative;
    z-index: 20;
  }
  .menu-btn {
    display: none;
    border: 0;
    background: transparent;
    color: var(--text);
    padding: 6px;
    border-radius: 50%;
    cursor: pointer;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--text);
    text-decoration: none;
    width: calc(var(--sidebar-width) - var(--space-5) - var(--space-4));
    flex: none;
    min-width: 0;
  }
  .brand:hover {
    text-decoration: none;
  }
  .brand-text {
    display: flex;
    flex-direction: column;
    line-height: 1.05;
    min-width: 0;
  }
  .product {
    font-family: var(--font-display);
    font-weight: 800;
    font-size: 19px;
    letter-spacing: -0.04em;
  }
  .company {
    font-size: 11px;
    color: var(--text-muted);
    font-weight: 700;
  }
  .search {
    flex: 1;
    max-width: 520px;
    min-width: 0;
  }
  /* Wide screens show the search field itself; `.tool` sets display, so the toggle needs both classes. */
  .tool.search-toggle {
    display: none;
  }
  .search-row {
    position: absolute;
    left: 0;
    right: 0;
    top: 100%;
    padding: var(--space-2) var(--space-4) var(--space-3);
    background: var(--surface);
    border-bottom: 1px solid var(--line);
    box-shadow: var(--shadow-md);
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
  }
  .tool {
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
  .lang {
    font-weight: 800;
    font-size: 12px;
  }
  .expert {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 36px;
    padding: 0 10px 0 12px;
    border: 1.5px solid var(--line-strong);
    border-radius: var(--radius-pill);
    background: var(--surface);
    color: var(--text-muted);
    font-weight: 800;
    font-size: var(--text-sm);
    cursor: pointer;
  }
  .expert.on {
    background: var(--lime);
    border-color: var(--lime);
    color: var(--on-lime);
  }
  .sw {
    width: 28px;
    height: 16px;
    border-radius: var(--radius-pill);
    background: var(--line-strong);
    position: relative;
    transition: background 0.15s var(--ease);
  }
  .sw span {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.15s var(--ease);
  }
  .on .sw {
    background: var(--on-lime);
  }
  .on .sw span {
    transform: translateX(12px);
    background: var(--lime);
  }
  .mucki {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 36px;
    padding: 0 14px;
    border: 0;
    border-radius: var(--radius-pill);
    background: var(--mucki);
    color: var(--on-mucki);
    font-weight: 800;
    cursor: pointer;
  }
  @media (max-width: 1100px) {
    .expert-label {
      display: none;
    }
  }
  @media (max-width: 1000px) {
    .search {
      display: none;
    }
    .tool.search-toggle {
      display: grid;
    }
  }
  @media (min-width: 1001px) {
    .search-row {
      display: none;
    }
  }
  @media (max-width: 760px) {
    .menu-btn {
      display: grid;
    }
    .topbar {
      padding: 0 var(--space-2) 0 var(--space-3);
      gap: var(--space-2);
    }
    .brand {
      width: auto;
    }
    .company,
    .lang,
    .theme,
    .mucki,
    .presence-slot {
      display: none;
    }
    .expert {
      padding: 0 8px;
      gap: 5px;
    }
    .tools {
      gap: 2px;
    }
  }
  @media (max-width: 360px) {
    .product {
      display: none;
    }
  }
</style>
