<!--
  The sidebar: the pages this person may open, by section. A drawer on phones.
-->
<script lang="ts">
  import { store } from '#lib/api/store.svelte.js';
  import { t } from '#lib/i18n/index.svelte.js';
  import { pageAt, SECTIONS, visiblePages } from '#lib/nav.js';
  import { href, router } from '#lib/state/router.svelte.js';
  import { currentActor, isExpert } from '#lib/state/session.svelte.js';
  import ExpertTag from '#lib/ui/ExpertTag.svelte';

  let { open, onclose }: { open: boolean; onclose: () => void } = $props();
  /** The drawer slides only once the person has opened it, never when the window crosses into
   * phone width. */
  let animated = $state(false);
  $effect(() => {
    if (open) {
      animated = true;
    }
  });

  const pages = $derived(visiblePages(currentActor().role, isExpert()));
  const sections = $derived(
    SECTIONS.map(section => ({
      ...section,
      pages: pages.filter(page => page.section === section.id)
    })).filter(section => section.pages.length > 0)
  );
  const activeId = $derived(pageAt(router.route.path)?.id);
</script>

{#if open}<button
    type="button"
    class="scrim"
    aria-label={t('common.close')}
    onclick={onclose}
  ></button>{/if}
<nav class="sidebar" class:open class:animated aria-label={t('nav.label')}>
  {#each sections as section (section.id)}
    <div class="section">
      <h4>{t(section.label)}</h4>
      {#each section.pages as page (page.id)}
        {@const Glyph = page.icon}
        <a
          class="item"
          class:on={page.id === activeId}
          href={href(page.patterns[0]?.split('/:')[0] ?? '/')}
        >
          <Glyph size={18} />
          <span class="grow">{t(page.label)}</span>
          {#if page.expertOnly}<ExpertTag always />{/if}
        </a>
      {/each}
    </div>
  {/each}
  <p class="version">Zamfono {store.db.system.api.version}</p>
</nav>

<style>
  .sidebar {
    width: var(--sidebar-width);
    flex: none;
    overflow-y: auto;
    padding: var(--space-4) var(--space-3) var(--space-6);
    background: var(--surface);
    border-right: 1px solid var(--line);
    scrollbar-width: thin;
  }
  .section {
    margin-bottom: var(--space-4);
  }
  h4 {
    font-family: var(--font-body);
    font-size: 11px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-faint);
    padding: 0 12px;
    margin-bottom: 4px;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 11px;
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-weight: 700;
    font-size: var(--text-md);
    text-decoration: none;
    transition:
      background 0.12s var(--ease),
      color 0.12s var(--ease);
  }
  .item:hover {
    background: var(--surface-3);
    color: var(--text);
    text-decoration: none;
  }
  .item.on {
    background: var(--primary);
    color: var(--on-primary);
    box-shadow: var(--shadow-primary);
  }
  .version {
    font-size: 11px;
    color: var(--text-faint);
    padding: 0 12px;
  }
  .scrim {
    display: none;
  }
  @media (max-width: 760px) {
    .sidebar {
      position: fixed;
      top: 0;
      bottom: 0;
      left: 0;
      z-index: 90;
      width: min(300px, 85vw);
      transform: translateX(-102%);
      box-shadow: var(--shadow-lg);
    }
    .sidebar.animated {
      transition: transform 0.22s var(--ease);
    }
    .sidebar.open {
      transform: none;
    }
    .scrim {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 85;
      border: 0;
      background: var(--overlay);
    }
  }
</style>
