<!--
  The demo guide as a side panel from the demo bar. It leaves the mockup usable beside it, so its
  links into the mockup (`/history?as=jonas`) open next to it, and it keeps its place while closed.
  On a phone it covers the mockup and closes for such a link.
-->
<script lang="ts">
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import X from '@lucide/svelte/icons/x';

  import GuideBody from '#lib/guide/GuideBody.svelte';
  import { t } from '#lib/i18n/index.svelte.js';
  import { href } from '#lib/state/router.svelte.js';

  let { open, onclose }: { open: boolean; onclose: () => void } = $props();
  let scroller = $state<HTMLDivElement>();
</script>

<svelte:window
  onkeydown={event => {
    if (open && event.key === 'Escape') {
      onclose();
    }
  }}
/>

<aside
  class="guide"
  class:open
  inert={!open}
  aria-label={t('demo.guide.title')}
>
  <header>
    <div class="titles">
      <h2>{t('demo.guide.title')}</h2>
      <p>{t('demo.guide.subtitle')}</p>
    </div>
    <a
      class="icon"
      href={href('/guide')}
      target="_blank"
      rel="noopener"
      aria-label={t('demo.guide.page')}
      title={t('demo.guide.page')}
    >
      <ExternalLink size={16} />
    </a>
    <button
      type="button"
      class="icon"
      aria-label={t('demo.guide.close')}
      title={t('demo.guide.close')}
      onclick={onclose}
    >
      <X size={18} />
    </button>
  </header>
  <div class="scroller" bind:this={scroller}>
    <GuideBody
      {scroller}
      onroute={() => {
        if (matchMedia('(max-width: 760px)').matches) {
          onclose();
        }
      }}
    />
  </div>
</aside>

<style>
  /* Below the demo bar, which stays usable; on a phone the whole screen. */
  .guide {
    position: fixed;
    top: var(--demobar-height);
    right: 0;
    bottom: 0;
    z-index: 110;
    display: flex;
    flex-direction: column;
    width: min(600px, 100vw);
    background: var(--surface);
    color: var(--text);
    border-left: 1px solid var(--line);
    box-shadow: var(--shadow-lg);
    transform: translateX(105%);
    visibility: hidden;
    transition:
      transform 0.22s ease,
      visibility 0s linear 0.22s;
  }
  .guide.open {
    transform: none;
    visibility: visible;
    transition: transform 0.22s ease;
  }
  @media (prefers-reduced-motion: reduce) {
    .guide,
    .guide.open {
      transition: none;
    }
  }
  header {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-4) var(--space-4) var(--space-3) var(--space-5);
    background: var(--demo-bg);
    color: var(--demo-text);
    background-image: repeating-linear-gradient(
      -45deg,
      transparent 0 12px,
      rgb(255 255 255 / 3%) 12px 24px
    );
  }
  .titles {
    flex: 1;
    min-width: 0;
  }
  h2 {
    font-family: var(--font-display);
    font-weight: 800;
    font-size: var(--text-xl);
    text-wrap: balance;
  }
  header p {
    font-size: var(--text-xs);
    color: var(--demo-accent);
    font-weight: 700;
    letter-spacing: 0.03em;
  }
  .icon {
    display: grid;
    place-items: center;
    flex: none;
    width: 32px;
    height: 32px;
    border: 0;
    border-radius: var(--radius-pill);
    background: rgb(255 255 255 / 8%);
    color: inherit;
    cursor: pointer;
  }
  .icon:hover {
    background: rgb(255 255 255 / 16%);
  }
  .scroller {
    flex: 1;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  @media (max-width: 760px) {
    .guide {
      top: 0;
    }
    header {
      padding-top: calc(var(--space-4) + env(safe-area-inset-top, 0px));
    }
  }
</style>
