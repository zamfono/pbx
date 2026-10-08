<!--
  Type-ahead over people, ring groups and contacts (`search.query`), and over the app itself: its
  pages and every setting (`#lib/search/settingsSearch.js`). A setting opens its page and tab and
  flashes; an Expert-only one turns Expert mode on first.
-->
<script lang="ts">
  import BookUser from '@lucide/svelte/icons/book-user';
  import RadioTower from '@lucide/svelte/icons/radio-tower';
  import Search from '@lucide/svelte/icons/search';
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
  import User from '@lucide/svelte/icons/user';

  import { read } from '#lib/actions.svelte.js';
  import { formatPhone, t } from '#lib/i18n/index.svelte.js';
  import {
    placePath,
    searchFields,
    searchPages,
    type FieldHit,
    type PageHit
  } from '#lib/search/settingsSearch.js';
  import { go, router } from '#lib/state/router.svelte.js';
  import {
    currentActor,
    isExpert,
    setExpert
  } from '#lib/state/session.svelte.js';
  import ExpertTag from '#lib/ui/ExpertTag.svelte';

  type DirectoryHit = {
    kind: 'user' | 'ringGroup' | 'contact';
    id: string;
    name: string;
    detail: string | null;
  };
  type Hit = DirectoryHit | PageHit | FieldHit;

  let {
    autofocus = false,
    onpick
  }: { autofocus?: boolean; onpick?: () => void } = $props();
  let query = $state('');
  let input = $state<HTMLInputElement>();
  $effect(() => {
    if (autofocus) {
      input?.focus();
    }
  });
  let focused = $state(false);
  let active = $state(0);
  const role = $derived(currentActor().role);
  const isAdmin = $derived(role !== 'user');
  const directory = $derived(
    query.trim().length < 1
      ? []
      : read<{ items: DirectoryHit[] }>(
          'search.query',
          { q: query.trim(), limit: 5 },
          { items: [] }
        ).items
  );
  const pages = $derived(searchPages(query, role, isExpert()));
  const fields = $derived(
    searchFields(query, role, isExpert(), 6, router.route.path)
  );
  const groups = $derived(
    (
      [
        {
          id: 'directory',
          label: t('search.group.directory'),
          hits: directory
        },
        { id: 'pages', label: t('search.group.pages'), hits: pages },
        { id: 'settings', label: t('search.group.settings'), hits: fields }
      ] as { id: string; label: string; hits: Hit[] }[]
    ).filter(group => group.hits.length > 0)
  );
  const hits = $derived<Hit[]>(groups.flatMap(group => group.hits));
  $effect(() => {
    void query;
    active = 0;
  });

  const keyOf = (hit: Hit): string =>
    hit.kind === 'page'
      ? `page:${hit.page.id}`
      : hit.kind === 'field'
        ? `field:${hit.entity}.${hit.key}`
        : `${hit.kind}:${hit.id}`;

  function open(hit: Hit): void {
    query = '';
    onpick?.();
    if (hit.kind === 'page' || hit.kind === 'field') {
      if (hit.expert) {
        setExpert(true);
      }
      if (hit.kind === 'page') {
        go(hit.page.patterns[0]?.split('/:')[0] ?? '/overview');
      } else {
        go(placePath(hit.place, router.route.path), {
          highlight: `field:${hit.entity}.${hit.key}`
        });
      }
    } else if (hit.kind === 'user') {
      go(isAdmin ? `/users/${hit.id}` : '/phonebook', { highlight: hit.id });
    } else if (hit.kind === 'ringGroup') {
      go(isAdmin ? `/ring-groups/${hit.id}` : '/phonebook', {
        highlight: hit.id
      });
    } else {
      go('/phonebook', { highlight: hit.id });
    }
  }
</script>

<div class="search" class:open={focused && hits.length > 0}>
  <Search size={17} />
  <input
    bind:this={input}
    type="search"
    placeholder={t('search.placeholder')}
    aria-label={t('search.placeholder')}
    bind:value={query}
    onfocus={() => (focused = true)}
    onblur={() => setTimeout(() => (focused = false), 150)}
    onkeydown={event => {
      if (event.key === 'ArrowDown') {
        active = Math.min(active + 1, hits.length - 1);
        event.preventDefault();
      } else if (event.key === 'ArrowUp') {
        active = Math.max(active - 1, 0);
        event.preventDefault();
      } else if (event.key === 'Enter') {
        const hit = hits[active];
        if (hit !== undefined) {
          open(hit);
        }
      }
    }}
  />
  <kbd>/</kbd>
  {#if focused && hits.length > 0}
    <div class="results" role="listbox" aria-label={t('search.placeholder')}>
      {#each groups as group (group.id)}
        <p class="group">{group.label}</p>
        <ul>
          {#each group.hits as hit (keyOf(hit))}
            {@const index = hits.indexOf(hit)}
            <li role="option" aria-selected={index === active}>
              <button
                type="button"
                class:active={index === active}
                onmousedown={() => open(hit)}
              >
                {#if hit.kind === 'page'}
                  {@const Glyph = hit.page.icon}
                  <span class="icon"><Glyph size={15} /></span>
                  <span class="grow truncate"
                    ><strong>{t(hit.page.label)}</strong></span
                  >
                  {#if hit.expert}<ExpertTag always />{/if}
                {:else if hit.kind === 'field'}
                  <span class="icon"><SlidersHorizontal size={15} /></span>
                  <span class="grow text">
                    <strong class="truncate">{hit.label}</strong>
                    <span class="where truncate">{hit.where}</span>
                  </span>
                  {#if hit.expert}<ExpertTag always />{/if}
                {:else}
                  <span class="icon">
                    {#if hit.kind === 'user'}<User
                        size={15}
                      />{:else if hit.kind === 'ringGroup'}<RadioTower
                        size={15}
                      />{:else}<BookUser size={15} />{/if}
                  </span>
                  <span class="grow truncate"><strong>{hit.name}</strong></span>
                  {#if hit.detail}<span class="detail mono"
                      >{hit.detail.startsWith('+')
                        ? formatPhone(hit.detail)
                        : hit.detail}</span
                    >{/if}
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/each}
    </div>
  {/if}
</div>

<svelte:window
  onkeydown={event => {
    if (
      event.key === '/' &&
      !(event.target instanceof HTMLInputElement) &&
      !(event.target instanceof HTMLTextAreaElement)
    ) {
      event.preventDefault();
      document
        .querySelector<HTMLInputElement>('.topbar input[type="search"]')
        ?.focus();
    }
  }}
/>

<style>
  .search {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 40px;
    padding: 0 12px;
    background: var(--surface-2);
    border: 1.5px solid var(--line);
    border-radius: var(--radius-pill);
    color: var(--text-muted);
  }
  .search:focus-within {
    border-color: var(--primary);
    background: var(--surface);
  }
  input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--text);
  }
  input::-webkit-search-cancel-button {
    display: none;
  }
  kbd {
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 5px;
    border: 1px solid var(--line-strong);
    color: var(--text-faint);
  }
  .results {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    right: 0;
    max-height: min(70vh, 560px);
    overflow-y: auto;
    padding: 6px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    z-index: 70;
  }
  .results button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    cursor: pointer;
    text-align: left;
    color: var(--text);
  }
  .results button.active,
  .results button:hover {
    background: var(--primary-soft);
  }
  .icon {
    color: var(--text-muted);
    display: grid;
  }
  .detail {
    font-size: 12px;
    color: var(--text-muted);
  }
  .results ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .group {
    padding: 8px 10px 4px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .where {
    font-size: 12px;
    color: var(--text-muted);
  }
</style>
