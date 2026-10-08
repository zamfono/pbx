<!--
  Initials in a coloured circle, optionally with a presence dot.
-->
<script lang="ts">
  import type { PresenceStatus } from '#lib/api/types.js';

  import Presence from './Presence.svelte';

  let {
    name,
    size = 34,
    status
  }: { name: string; size?: number; status?: PresenceStatus } = $props();

  const PALETTE = [
    '#4b2ee8',
    '#ff5c39',
    '#1f9d55',
    '#2f6fe0',
    '#b0310f',
    '#7a3fe0',
    '#0f8f8f',
    '#c27c00'
  ];
  const initials = $derived(
    name
      .replace(/^Dr\.\s*/u, '')
      .split(/\s+/u)
      .filter(Boolean)
      .slice(0, 2)
      .map(part => part[0]?.toUpperCase() ?? '')
      .join('')
  );
  const color = $derived(
    PALETTE[
      [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) %
        PALETTE.length
    ]
  );
</script>

<span
  class="avatar"
  style:width="{size}px"
  style:height="{size}px"
  style:font-size="{size * 0.38}px"
  style:--avatar={color}
>
  {initials}
  {#if status}
    <span class="status"
      ><Presence {status} size={Math.max(8, size * 0.28)} /></span
    >
  {/if}
</span>

<style>
  .avatar {
    position: relative;
    display: inline-grid;
    place-items: center;
    flex: none;
    border-radius: 50%;
    font-family: var(--font-display);
    font-weight: 800;
    color: #fff;
    background: var(--avatar);
    letter-spacing: -0.02em;
  }
  .status {
    position: absolute;
    right: -1px;
    bottom: -1px;
    line-height: 0;
  }
</style>
