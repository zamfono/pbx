<!--
  The Zamfono Z glyph (trademark, TRADEMARKS.md), in the current text or primary colour.
-->
<script lang="ts">
  let {
    size = 28,
    color = 'var(--primary)'
  }: { size?: number; color?: string } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 256 256" aria-hidden="true">
  <path
    fill="none"
    stroke={color}
    stroke-width="22"
    stroke-linecap="round"
    stroke-linejoin="round"
    d="M 91.241 91.241 H 164.759 L 91.241 164.759 H 159.508 C 201.518 164.759 230.4 159.508 230.4 128 A 102.4 102.4 0 1 0 200.468 200.468"
  />
</svg>
