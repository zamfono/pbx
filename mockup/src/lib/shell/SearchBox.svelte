<!--
  Type-ahead over users, ring groups and contacts (`search.query`).
-->
<script lang="ts">
  import BookUser from '@lucide/svelte/icons/book-user';
  import RadioTower from '@lucide/svelte/icons/radio-tower';
  import Search from '@lucide/svelte/icons/search';
  import User from '@lucide/svelte/icons/user';

  import { read } from '#lib/actions.svelte.js';
  import { formatPhone, t } from '#lib/i18n/index.svelte.js';
  import { go } from '#lib/state/router.svelte.js';
  import { currentActor } from '#lib/state/session.svelte.js';

  type Hit = {
    kind: 'user' | 'ringGroup' | 'contact';
    id: string;
    name: string;
    detail: string | null;
  };

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
  const hits = $derived(
    query.trim().length < 1
      ? []
      : read<{ items: Hit[] }>(
          'search.query',
          { q: query.trim(), limit: 8 },
          { items: [] }
        ).items
  );
  const isAdmin = $derived(currentActor().role !== 'user');

  function open(hit: Hit): void {
    query = '';
    onpick?.();
    if (hit.kind === 'user') {
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
    <ul class="results" role="listbox">
      {#each hits as hit, index (hit.kind + hit.id)}
        <li role="option" aria-selected={index === active}>
          <button
            type="button"
            class:active={index === active}
            onmousedown={() => open(hit)}
          >
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
          </button>
        </li>
      {/each}
    </ul>
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
    list-style: none;
    margin: 0;
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
</style>
