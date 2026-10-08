<!--
  The frame of every sign-in page: the company's brand panel (the Z, `settings.companyName` as the
  title, the stack's domain), language and theme switches, the page's card and an optional aside
  below it. On phones the brand panel shrinks to a header band.
-->
<script lang="ts">
  import LockKeyhole from '@lucide/svelte/icons/lock-keyhole';
  import Monitor from '@lucide/svelte/icons/monitor';
  import Moon from '@lucide/svelte/icons/moon';
  import Sun from '@lucide/svelte/icons/sun';
  import type { Snippet } from 'svelte';

  import { store } from '#lib/api/store.svelte.js';
  import { t } from '#lib/i18n/index.svelte.js';
  import Logo from '#lib/shell/Logo.svelte';
  import {
    session,
    setLocale,
    setTheme,
    type Theme
  } from '#lib/state/session.svelte.js';

  let { children, aside }: { children: Snippet; aside?: Snippet } = $props();

  const companyName = $derived(store.db.settings.companyName);
  const domain = $derived(store.db.system.stack.domain);
  const NEXT_THEME: Record<Theme, Theme> = {
    system: 'light',
    light: 'dark',
    dark: 'system'
  };
  const BARS = [
    5, 9, 14, 8, 18, 26, 16, 30, 22, 12, 20, 28, 15, 9, 19, 11, 6, 13, 24, 17,
    10, 7, 4
  ];
</script>

<div class="auth">
  <aside class="brand">
    <div class="glow lime" aria-hidden="true"></div>
    <div class="glow coral" aria-hidden="true"></div>
    <div class="watermark" aria-hidden="true">
      <Logo size={520} color="currentColor" />
    </div>

    <div class="brand-top">
      <span class="mark"><Logo size={30} color="var(--lime)" /></span>
      <span class="wordmark">Zamfono</span>
    </div>

    <div class="brand-main">
      <span class="eyebrow">{t('auth.brand.eyebrow')}</span>
      <p class="company">{companyName}</p>
      <p class="tagline">{t('auth.brand.tagline')}</p>
      <div class="wave" aria-hidden="true">
        {#each BARS as height, index (index)}
          <span style:--h="{height * 3}px" style:--d="{index * 70}ms"></span>
        {/each}
      </div>
    </div>

    <div class="brand-foot">
      <LockKeyhole size={14} />
      <span>{domain}</span>
    </div>
  </aside>

  <main class="content">
    <div class="toolbar">
      <div class="locale" role="group" aria-label={t('auth.layout.language')}>
        <button
          type="button"
          class:on={session.locale === 'de'}
          aria-pressed={session.locale === 'de'}
          onclick={() => setLocale('de')}>DE</button
        >
        <button
          type="button"
          class:on={session.locale === 'en'}
          aria-pressed={session.locale === 'en'}
          onclick={() => setLocale('en')}>EN</button
        >
      </div>
      <button
        type="button"
        class="theme"
        aria-label={t('topbar.theme', { theme: t(`theme.${session.theme}`) })}
        title={t('topbar.theme', { theme: t(`theme.${session.theme}`) })}
        onclick={() => setTheme(NEXT_THEME[session.theme])}
      >
        {#if session.theme === 'light'}<Sun
            size={17}
          />{:else if session.theme === 'dark'}<Moon size={17} />{:else}<Monitor
            size={17}
          />{/if}
      </button>
    </div>
    <div class="column">
      <div class="card">
        {@render children()}
      </div>
      {#if aside}
        {@render aside()}
      {/if}
    </div>
  </main>
</div>

<style>
  .auth {
    min-height: 100dvh;
    display: grid;
    grid-template-columns: minmax(380px, 44%) 1fr;
    background: var(--bg);
  }

  /* ---- Brand panel ---- */
  .brand {
    position: sticky;
    top: 0;
    height: 100dvh;
    overflow: hidden;
    isolation: isolate;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: var(--space-6);
    padding: var(--space-6) clamp(var(--space-6), 5vw, 72px);
    color: var(--on-primary);
    background:
      radial-gradient(
        120% 80% at 0% 100%,
        color-mix(in srgb, var(--primary-hover) 70%, var(--on-lime)) 0%,
        transparent 60%
      ),
      linear-gradient(160deg, var(--primary) 0%, var(--primary-hover) 100%);
  }
  .glow {
    position: absolute;
    border-radius: 50%;
    z-index: -1;
    filter: blur(2px);
  }
  .glow.lime {
    width: 340px;
    height: 340px;
    right: -120px;
    top: -110px;
    background: var(--lime);
    opacity: 0.95;
  }
  .glow.coral {
    width: 130px;
    height: 130px;
    right: 18%;
    bottom: 16%;
    background: var(--mucki);
    animation: float 9s ease-in-out infinite;
  }
  .watermark {
    position: absolute;
    left: -150px;
    bottom: -170px;
    z-index: -1;
    color: var(--on-primary);
    opacity: 0.08;
    transform: rotate(-8deg);
  }
  .brand-top {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .mark {
    display: grid;
    place-items: center;
    width: 46px;
    height: 46px;
    border-radius: 14px;
    background: var(--on-lime);
  }
  .wordmark {
    font-family: var(--font-display);
    font-weight: 800;
    font-size: var(--text-xl);
    letter-spacing: -0.02em;
  }
  .brand-main {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    max-width: 520px;
  }
  .eyebrow {
    align-self: flex-start;
    font-size: var(--text-xs);
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--on-lime);
    background: var(--lime);
    padding: 5px 12px;
    border-radius: var(--radius-pill);
  }
  .company {
    font-family: var(--font-display);
    font-weight: 800;
    font-size: clamp(40px, 4.6vw, 64px);
    line-height: 0.98;
    letter-spacing: -0.045em;
    text-wrap: balance;
  }
  .tagline {
    font-size: var(--text-lg);
    line-height: 1.5;
    opacity: 0.86;
    max-width: 400px;
  }
  .wave {
    display: flex;
    align-items: center;
    gap: 5px;
    height: 96px;
    margin-top: var(--space-3);
  }
  .wave span {
    width: 6px;
    height: var(--h);
    border-radius: var(--radius-pill);
    background: var(--lime);
    opacity: 0.9;
    animation: wave 1.8s var(--ease) var(--d) infinite alternate;
  }
  .wave span:nth-child(5n) {
    background: var(--mucki);
  }
  .brand-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--text-sm);
    font-weight: 500;
    opacity: 0.8;
  }

  /* ---- Content ---- */
  .content {
    min-width: 0;
    display: flex;
    flex-direction: column;
    padding: var(--space-5) var(--space-6) var(--space-7);
  }
  .toolbar {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: var(--space-2);
  }
  .locale {
    display: inline-flex;
    padding: 3px;
    gap: 2px;
    border-radius: var(--radius-pill);
    background: var(--surface-3);
  }
  .locale button,
  .theme {
    border: 0;
    cursor: pointer;
    font-weight: 700;
    font-size: var(--text-xs);
    color: var(--text-muted);
    background: transparent;
  }
  .locale button {
    padding: 4px 10px;
    border-radius: var(--radius-pill);
  }
  .locale button.on {
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-sm);
  }
  .theme {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
  }
  .theme:hover {
    background: var(--surface-3);
    color: var(--text);
  }
  .column {
    flex: 1;
    width: 100%;
    max-width: 460px;
    margin: 0 auto;
    padding-top: clamp(var(--space-5), 8vh, 96px);
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    padding: var(--space-6);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    animation: enter 0.35s var(--ease);
  }

  @keyframes wave {
    from {
      transform: scaleY(0.35);
    }
    to {
      transform: scaleY(1);
    }
  }
  @keyframes float {
    50% {
      transform: translate(-16px, -22px);
    }
  }
  @keyframes enter {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
  }

  @media (max-width: 960px) {
    .auth {
      grid-template-columns: 1fr;
    }
    .brand {
      position: relative;
      height: auto;
      padding: var(--space-5) var(--space-4) var(--space-6);
      gap: var(--space-4);
      border-radius: 0 0 var(--radius-lg) var(--radius-lg);
    }
    .glow.lime {
      width: 200px;
      height: 200px;
      right: -70px;
      top: -90px;
    }
    .glow.coral,
    .wave,
    .tagline,
    .brand-foot {
      display: none;
    }
    .watermark {
      left: auto;
      right: -60px;
      bottom: -120px;
      transform: rotate(-8deg) scale(0.5);
      transform-origin: bottom right;
    }
    .brand-main {
      gap: var(--space-2);
    }
    .company {
      font-size: clamp(28px, 8vw, 40px);
    }
    .content {
      padding: var(--space-3) var(--space-4) var(--space-6);
    }
    .toolbar {
      position: absolute;
      top: var(--space-5);
      right: var(--space-4);
    }
    .toolbar .theme {
      color: var(--on-lime);
    }
    .toolbar .locale {
      background: color-mix(in srgb, var(--on-lime) 12%, transparent);
    }
    .toolbar .locale button {
      color: var(--on-lime);
    }
    .column {
      padding-top: 0;
      margin-top: calc(-1 * var(--space-4));
      position: relative;
    }
    .card {
      padding: var(--space-5);
    }
  }
</style>
