<!--
  The demo guide on a page of its own, for reading ahead of a demo; its links into the mockup open
  the mockup in this tab.
-->
<script lang="ts">
  import ArrowRight from '@lucide/svelte/icons/arrow-right';

  import { guideTitle } from '#lib/guide/guide.js';
  import GuideBody from '#lib/guide/GuideBody.svelte';
  import { t } from '#lib/i18n/index.svelte.js';
  import Logo from '#lib/shell/Logo.svelte';
  import { href } from '#lib/state/router.svelte.js';
</script>

<svelte:head>
  <title>{t('demo.guide.title')} · Zamfono</title>
</svelte:head>

<div class="page">
  <header>
    <div class="inner">
      <Logo size={30} color="var(--demo-accent)" />
      <div class="titles">
        <h1>{t('demo.guide.title')}</h1>
        <p>{guideTitle}</p>
      </div>
      <a class="open" href={href('/')}
        >{t('demo.guide.openDemo')} <ArrowRight size={15} /></a
      >
    </div>
  </header>
  <main>
    <GuideBody />
  </main>
</div>

<style>
  .page {
    min-height: 100dvh;
    background: var(--surface);
    color: var(--text);
  }
  header {
    background: var(--demo-bg);
    color: var(--demo-text);
    background-image: repeating-linear-gradient(
      -45deg,
      transparent 0 12px,
      rgb(255 255 255 / 3%) 12px 24px
    );
  }
  .inner {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-3) var(--space-4);
    max-width: 880px;
    margin: 0 auto;
    padding: var(--space-5);
    padding-top: calc(var(--space-5) + env(safe-area-inset-top, 0px));
  }
  .titles {
    flex: 1;
    min-width: 0;
  }
  h1 {
    font-family: var(--font-display);
    font-weight: 800;
    font-size: var(--text-2xl);
    line-height: 1.15;
    text-wrap: balance;
  }
  .titles p {
    color: var(--demo-accent);
    font-size: var(--text-sm);
    font-weight: 700;
  }
  .open {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    border-radius: var(--radius-pill);
    background: var(--demo-accent);
    color: var(--on-lime);
    font-weight: 800;
    font-size: var(--text-sm);
    text-decoration: none;
    white-space: nowrap;
  }
  main {
    max-width: 880px;
    margin: 0 auto;
  }
</style>
