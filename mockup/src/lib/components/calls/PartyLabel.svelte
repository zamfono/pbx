<!--
  Who a number is: a colleague (with presence), a phone-book contact, a ring group, an own number,
  or the bare number — avatar, name and a second line.
-->
<script lang="ts">
  import EyeOff from '@lucide/svelte/icons/eye-off';
  import Hash from '@lucide/svelte/icons/hash';
  import RadioTower from '@lucide/svelte/icons/radio-tower';
  import SquareParking from '@lucide/svelte/icons/square-parking';
  import UserRound from '@lucide/svelte/icons/user-round';

  import { presenceOf } from '#lib/api/lookup.js';
  import { formatPhone } from '#lib/i18n/index.svelte.js';
  import Avatar from '#lib/ui/Avatar.svelte';
  import Icon from '#lib/ui/Icon.svelte';

  import { party, type Party } from './labels';

  type Props = {
    /** A number, extension or SIP URI; or a resolved party. */
    value?: string;
    who?: Party;
    size?: number;
    /** Show the number under the name (default) or the detail line. */
    secondary?: 'number' | 'detail' | 'none';
    presence?: boolean;
  };

  let {
    value = '',
    who,
    size = 34,
    secondary = 'number',
    presence = false
  }: Props = $props();

  const resolved = $derived(who ?? party(value));
  const title = $derived(resolved.name ?? formatPhone(resolved.number));
  const second = $derived.by(() => {
    if (secondary === 'none' || resolved.name === null) {
      return null;
    }
    if (secondary === 'detail') {
      return (
        resolved.detail ??
        (resolved.number ? formatPhone(resolved.number) : null)
      );
    }
    if (resolved.kind === 'user' || resolved.kind === 'ringGroup') {
      return resolved.detail;
    }
    return resolved.number ? formatPhone(resolved.number) : resolved.detail;
  });
  const glyph = $derived(
    resolved.kind === 'ringGroup'
      ? RadioTower
      : resolved.kind === 'parking'
        ? SquareParking
        : resolved.kind === 'anonymous'
          ? EyeOff
          : resolved.kind === 'did'
            ? Hash
            : UserRound
  );
</script>

<span class="party">
  {#if resolved.kind === 'user' || resolved.kind === 'contact'}
    <Avatar
      name={title}
      {size}
      status={presence && resolved.userId
        ? presenceOf(resolved.userId)
        : undefined}
    />
  {:else}
    <span class="glyph" style:width="{size}px" style:height="{size}px"
      ><Icon icon={glyph} size={Math.round(size * 0.48)} /></span
    >
  {/if}
  <span class="text">
    <span class="name truncate" class:mono={resolved.name === null}
      >{title}</span
    >
    {#if second}<span class="second truncate">{second}</span>{/if}
  </span>
</span>

<style>
  .party {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
    max-width: 100%;
  }
  .glyph {
    display: grid;
    place-items: center;
    flex: none;
    border-radius: 50%;
    background: var(--surface-3);
    color: var(--text-muted);
  }
  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.25;
  }
  .name {
    font-weight: 700;
    color: var(--text);
  }
  .second {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
</style>
