<!--
  The demo guide in the mockup's language, for the demo bar's panel and the /guide page. Its
  contents scroll the guide's own scroller to a section.
-->
<script lang="ts">
  import { i18n, t } from '#lib/i18n/index.svelte.js';

  import { guides } from './guide.js';

  let {
    scroller,
    onroute
  }: {
    /** The element that scrolls the guide; the page itself when absent. */
    scroller?: HTMLElement | undefined;
    /** Called when a link into the mockup is followed. */
    onroute?: () => void;
  } = $props();
  let content = $state<HTMLDivElement>();
  const guide = $derived(guides[i18n.locale]);

  function jump(id: string): void {
    const target = content?.querySelector(`#${id}`);
    if (target instanceof HTMLElement) {
      const top = scroller
        ? target.offsetTop - scroller.offsetTop
        : target.getBoundingClientRect().top + window.scrollY;
      (scroller ?? window).scrollTo({ top: top - 64, behavior: 'smooth' });
    }
  }
</script>

<nav aria-label={t('demo.guide.contents')}>
  {#each guide.sections as section, index (section.id)}
    <button type="button" onclick={() => jump(section.id)}>
      <span class="nums">{index + 1}</span>
      {section.title}
    </button>
  {/each}
</nav>
<div
  class="content"
  bind:this={content}
  role="presentation"
  onclick={event => {
    if ((event.target as Element).closest('a.route') !== null) {
      onroute?.();
    }
  }}
>
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- the repository's own guide -->
  {@html guide.html}
</div>

<style>
  nav {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    gap: 6px;
    padding: var(--space-3) var(--space-5);
    overflow-x: auto;
    scrollbar-width: none;
    border-bottom: 1px solid var(--line);
    background: var(--surface-2);
  }
  nav button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: none;
    border: 1px solid var(--line);
    border-radius: var(--radius-pill);
    background: var(--surface);
    color: var(--text);
    padding: 4px 10px 4px 4px;
    font-size: var(--text-xs);
    font-weight: 700;
    white-space: nowrap;
    cursor: pointer;
  }
  nav button:hover {
    border-color: var(--primary);
  }
  nav .nums {
    display: grid;
    place-items: center;
    min-width: 18px;
    height: 18px;
    border-radius: var(--radius-pill);
    background: var(--primary-soft);
    color: var(--primary);
    font-size: 10px;
  }
  .content {
    padding: var(--space-4) var(--space-5) var(--space-7);
    font-size: var(--text-md);
    line-height: 1.55;
  }
  .content > :global(:first-child) {
    margin-top: 0;
  }
  .content :global(h2) {
    font-family: var(--font-display);
    font-weight: 800;
    font-size: var(--text-xl);
    margin: var(--space-6) 0 var(--space-2);
    text-wrap: balance;
  }
  .content :global(h3) {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: var(--text-lg);
    margin: var(--space-5) 0 var(--space-2);
  }
  .content :global(p),
  .content :global(ul),
  .content :global(ol) {
    margin: 0 0 var(--space-3);
  }
  .content :global(ul),
  .content :global(ol) {
    padding-left: 1.3em;
  }
  .content :global(li) {
    margin-bottom: 4px;
  }
  .content :global(strong) {
    font-weight: 700;
  }
  .content :global(code) {
    font-family: var(--font-mono);
    font-size: 0.88em;
    padding: 1px 5px;
    border-radius: var(--radius-xs);
    background: var(--surface-3);
  }
  .content :global(a) {
    color: var(--primary);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .content :global(a.route) {
    text-decoration: none;
  }
  .content :global(a.route code) {
    background: var(--primary-soft);
    color: var(--primary);
  }
  .content :global(a.route:hover code) {
    outline: 1px solid var(--primary);
  }
  .content :global(blockquote) {
    margin: 0 0 var(--space-3);
    padding: var(--space-2) var(--space-3);
    border-left: 3px solid var(--demo-accent);
    background: var(--surface-2);
  }
  .content :global(.table) {
    overflow-x: auto;
    margin: 0 0 var(--space-4);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
  }
  .content :global(table) {
    border-collapse: collapse;
    width: 100%;
    font-size: var(--text-sm);
  }
  .content :global(th),
  .content :global(td) {
    padding: 7px 10px;
    text-align: left;
    vertical-align: top;
    border-bottom: 1px solid var(--line);
  }
  .content :global(tr:last-child td) {
    border-bottom: 0;
  }
  .content :global(th) {
    background: var(--surface-2);
    font-weight: 700;
    white-space: nowrap;
  }
  .content :global(td:first-child) {
    min-width: 9em;
  }
</style>
