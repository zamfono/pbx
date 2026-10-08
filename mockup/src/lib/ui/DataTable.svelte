<!--
  A table that becomes a card list on narrow screens. Columns are described once; `cell` renders a
  cell, `rowKey` identifies rows (the highlighted one flashes), `onRowClick` makes rows links.
-->
<script lang="ts" generics="T">
  import type { Snippet } from 'svelte';

  import { router } from '#lib/state/router.svelte.js';

  type Column = {
    key: string;
    label: string;
    width?: string;
    align?: 'left' | 'right' | 'center';
    /** Hidden in the card layout (the card's title already shows it, or it is secondary). */
    hideOnMobile?: boolean;
    /** The card's title column on narrow screens. */
    primary?: boolean;
  };

  type Props = {
    rows: T[];
    columns: Column[];
    rowKey: (row: T) => string;
    cell: Snippet<[T, string]>;
    onRowClick?: (row: T) => void;
    empty?: Snippet;
    dense?: boolean;
    caption?: string;
  };

  let {
    rows,
    columns,
    rowKey,
    cell,
    onRowClick,
    empty,
    dense = false,
    caption
  }: Props = $props();
  const primary = $derived(
    columns.find(column => column.primary) ?? columns[0]
  );
</script>

{#if rows.length === 0 && empty}
  {@render empty()}
{:else}
  <div class="wrap">
    <table class:dense class:clickable={onRowClick !== undefined}>
      {#if caption}<caption class="sr-only">{caption}</caption>{/if}
      <thead>
        <tr>
          {#each columns as column (column.key)}
            <th
              style:width={column.width}
              style:text-align={column.align ?? 'left'}>{column.label}</th
            >
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each rows as row (rowKey(row))}
          <tr
            class:flash={router.highlight === rowKey(row)}
            onclick={() => onRowClick?.(row)}
            onkeydown={event => {
              if (event.key === 'Enter') {
                onRowClick?.(row);
              }
            }}
            tabindex={onRowClick ? 0 : undefined}
          >
            {#each columns as column (column.key)}
              <td style:text-align={column.align ?? 'left'}
                >{@render cell(row, column.key)}</td
              >
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <ul class="cards" class:clickable={onRowClick !== undefined}>
    {#each rows as row (rowKey(row))}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -- focusable only when rows are links (role=button) -->
      <li
        class:flash={router.highlight === rowKey(row)}
        onclick={() => onRowClick?.(row)}
        onkeydown={event => {
          if (event.key === 'Enter') {
            onRowClick?.(row);
          }
        }}
        tabindex={onRowClick ? 0 : undefined}
        role={onRowClick ? 'button' : undefined}
      >
        {#if primary}<div class="card-title">
            {@render cell(row, primary.key)}
          </div>{/if}
        <dl>
          {#each columns.filter(column => column !== primary && column.hideOnMobile !== true && column.label !== '') as column (column.key)}
            <div class="pair">
              <dt>{column.label}</dt>
              <dd>{@render cell(row, column.key)}</dd>
            </div>
          {/each}
        </dl>
        {#each columns.filter(column => column.label === '' && column !== primary) as column (column.key)}
          <div class="card-actions">{@render cell(row, column.key)}</div>
        {/each}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .wrap {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    overflow: hidden;
    overflow-x: auto;
    box-shadow: var(--shadow-sm);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-md);
  }
  th {
    text-align: left;
    font-size: var(--text-xs);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    padding: 11px 16px;
    background: var(--surface-2);
    border-bottom: 1px solid var(--line);
    white-space: nowrap;
  }
  td {
    padding: 12px 16px;
    border-bottom: 1px solid var(--line);
    vertical-align: middle;
  }
  .dense td {
    padding: 8px 16px;
  }
  tbody tr:last-child td {
    border-bottom: 0;
  }
  .clickable tbody tr {
    cursor: pointer;
  }
  .clickable tbody tr:hover {
    background: var(--surface-2);
  }
  .cards {
    display: none;
    list-style: none;
    margin: 0;
    padding: 0;
    gap: var(--space-3);
    flex-direction: column;
  }
  .cards li {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    padding: var(--space-4);
  }
  .card-title {
    font-weight: 700;
    margin-bottom: var(--space-2);
  }
  dl {
    margin: 0;
    display: grid;
    gap: 6px;
  }
  .pair {
    display: flex;
    justify-content: space-between;
    gap: var(--space-3);
    font-size: var(--text-sm);
  }
  dt {
    color: var(--text-muted);
  }
  dd {
    margin: 0;
    text-align: right;
    min-width: 0;
  }
  .card-actions {
    margin-top: var(--space-3);
    display: flex;
    justify-content: flex-end;
  }
  @media (max-width: 720px) {
    .wrap {
      display: none;
    }
    .cards {
      display: flex;
    }
  }
</style>
