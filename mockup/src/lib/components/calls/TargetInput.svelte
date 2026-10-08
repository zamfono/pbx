<!--
  Whom to call: an extension or a number typed as a phone would dial it, with suggestions from the
  directory (colleagues, ring groups) and the phone book. Picking a suggestion fills in its
  extension or number.
-->
<script lang="ts">
  import BookUser from '@lucide/svelte/icons/book-user';
  import RadioTower from '@lucide/svelte/icons/radio-tower';

  import { presenceOf } from '#lib/api/lookup.js';
  import { store } from '#lib/api/store.svelte.js';
  import { formatPhone, t } from '#lib/i18n/index.svelte.js';
  import Avatar from '#lib/ui/Avatar.svelte';
  import Icon from '#lib/ui/Icon.svelte';

  type Suggestion = {
    key: string;
    value: string;
    name: string;
    detail: string;
    kind: 'user' | 'ringGroup' | 'contact';
    userId?: string;
  };

  type Props = {
    value: string;
    id: string;
    label?: string;
    placeholder?: string;
    /** Users not to offer (e.g. the caller themselves). */
    exclude?: string[];
    ringGroups?: boolean;
    invalid?: boolean;
    onenter?: () => void;
  };

  let {
    value = $bindable(),
    id,
    label,
    placeholder,
    exclude = [],
    ringGroups = true,
    invalid = false,
    onenter
  }: Props = $props();

  let open = $state(false);
  let active = $state(0);
  const MAX = 7;

  const all = $derived.by((): Suggestion[] => {
    const db = store.db;
    const users: Suggestion[] = db.users
      .filter(
        user =>
          user.deletedAt === null &&
          user.extension !== null &&
          !exclude.includes(user.id)
      )
      .map(user => ({
        key: `u:${user.id}`,
        value: user.extension ?? '',
        name: user.name,
        detail: t('calls.extension', { ext: user.extension }),
        kind: 'user',
        userId: user.id
      }));
    const groups: Suggestion[] = ringGroups
      ? db.ringGroups
          .filter(group => group.deletedAt === null)
          .map(group => ({
            key: `g:${group.id}`,
            value: group.ext,
            name: group.name,
            detail: t('calls.ringGroupExt', { ext: group.ext }),
            kind: 'ringGroup'
          }))
      : [];
    const contacts: Suggestion[] = db.contacts
      .filter(contact => contact.deletedAt === null)
      .flatMap(contact =>
        contact.phones.map(phone => ({
          key: `c:${contact.id}:${phone.number}`,
          value: phone.number,
          name: contact.displayName,
          detail: `${phone.label} · ${formatPhone(phone.number)}`,
          kind: 'contact' as const
        }))
      );
    return [...users, ...groups, ...contacts];
  });

  const matches = $derived.by(() => {
    const query = value.trim().toLowerCase();
    if (query === '') {
      return all.filter(item => item.kind === 'user').slice(0, MAX);
    }
    const digits = query.replace(/[^\d+]/gu, '');
    return all
      .filter(
        item =>
          item.name.toLowerCase().includes(query) ||
          (digits.length > 1 &&
            item.value.replace(/^\+49/u, '0').includes(digits)) ||
          (digits.length > 0 && item.value.includes(digits))
      )
      .slice(0, MAX);
  });

  function pick(item: Suggestion): void {
    value = item.value;
    open = false;
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' && matches.length > 0) {
      event.preventDefault();
      open = true;
      active = (active + 1) % matches.length;
    } else if (event.key === 'ArrowUp' && matches.length > 0) {
      event.preventDefault();
      active = (active - 1 + matches.length) % matches.length;
    } else if (event.key === 'Enter') {
      const item = matches[active];
      if (open && item !== undefined && value.trim() !== item.value) {
        event.preventDefault();
        pick(item);
      } else {
        // The submit may close a dialog and hand focus back to its opener; without this the
        // same Enter would press that button too.
        event.preventDefault();
        open = false;
        onenter?.();
      }
    } else if (event.key === 'Escape') {
      open = false;
    }
  }
</script>

<div class="combo">
  <input
    {id}
    type="text"
    inputmode="tel"
    autocomplete="off"
    role="combobox"
    aria-label={label}
    aria-expanded={open && matches.length > 0}
    aria-controls="{id}-list"
    aria-activedescendant={open && matches[active]
      ? `${id}-opt-${active}`
      : undefined}
    aria-invalid={invalid}
    class:invalid
    {placeholder}
    bind:value
    onfocus={() => {
      open = true;
      active = 0;
    }}
    oninput={() => {
      open = true;
      active = 0;
    }}
    onblur={() => setTimeout(() => (open = false), 120)}
    onkeydown={keydown}
  />
  {#if open && matches.length > 0}
    <ul class="list" id="{id}-list" role="listbox">
      {#each matches as item, index (item.key)}
        <li
          id="{id}-opt-{index}"
          role="option"
          aria-selected={index === active}
          class:active={index === active}
          onpointerdown={event => {
            event.preventDefault();
            pick(item);
          }}
        >
          {#if item.kind === 'user'}
            <Avatar
              name={item.name}
              size={26}
              status={item.userId ? presenceOf(item.userId) : undefined}
            />
          {:else}
            <span class="glyph"
              ><Icon
                icon={item.kind === 'ringGroup' ? RadioTower : BookUser}
                size={14}
              /></span
            >
          {/if}
          <span class="text">
            <span class="name truncate">{item.name}</span>
            <span class="detail truncate">{item.detail}</span>
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .combo {
    position: relative;
    width: 100%;
  }
  input {
    width: 100%;
    height: 42px;
    padding: 0 var(--space-4);
    border: 1.5px solid var(--line-strong);
    border-radius: var(--radius-pill);
    background: var(--surface);
    font-size: var(--text-md);
    outline: none;
    transition: border-color 0.15s var(--ease);
  }
  input:focus {
    border-color: var(--primary);
    box-shadow: 0 0 0 3px var(--primary-soft);
  }
  input.invalid {
    border-color: var(--danger);
  }
  .list {
    position: absolute;
    z-index: 30;
    left: 0;
    right: 0;
    top: calc(100% + 6px);
    margin: 0;
    padding: 6px;
    list-style: none;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    max-height: 320px;
    overflow-y: auto;
  }
  li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  li.active,
  li:hover {
    background: var(--surface-3);
  }
  .glyph {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: var(--primary-soft);
    color: var(--primary);
    flex: none;
  }
  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.25;
  }
  .name {
    font-weight: 700;
    font-size: var(--text-sm);
  }
  .detail {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
</style>
