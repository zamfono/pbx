<!--
  Mucki's mark: a small, friendly coral bot head with an antenna.
-->
<script lang="ts">
  let { size = 32, busy = false }: { size?: number; busy?: boolean } = $props();
</script>

<span
  class="avatar"
  class:busy
  style:width="{size}px"
  style:height="{size}px"
  aria-hidden="true"
>
  <svg viewBox="0 0 32 32" width={size * 0.78} height={size * 0.78}>
    <line x1="16" y1="3.5" x2="16" y2="8" class="stroke" />
    <circle cx="16" cy="3.5" r="2" class="dot" />
    <rect x="5" y="8" width="22" height="18" rx="7" class="head" />
    <circle cx="12" cy="16.5" r="2.2" class="eye" />
    <circle cx="20" cy="16.5" r="2.2" class="eye" />
    <path d="M12.5 21.2c1.9 1.6 5.1 1.6 7 0" class="smile" />
    <rect x="2" y="14" width="3" height="6" rx="1.5" class="ear" />
    <rect x="27" y="14" width="3" height="6" rx="1.5" class="ear" />
  </svg>
</span>

<style>
  .avatar {
    display: inline-grid;
    place-items: center;
    flex: none;
    border-radius: 34%;
    background: var(--mucki);
    box-shadow: 0 4px 12px color-mix(in srgb, var(--mucki) 35%, transparent);
  }
  .head {
    fill: var(--on-mucki);
  }
  .eye {
    fill: var(--mucki);
    transform-origin: center;
    transform-box: fill-box;
  }
  .smile {
    fill: none;
    stroke: var(--mucki);
    stroke-width: 1.8;
    stroke-linecap: round;
  }
  .stroke {
    stroke: var(--on-mucki);
    stroke-width: 1.8;
    stroke-linecap: round;
  }
  .dot,
  .ear {
    fill: var(--on-mucki);
  }
  .busy .eye {
    animation: blink 1.6s var(--ease) infinite;
  }
  .busy .dot {
    animation: glow 1.2s ease-in-out infinite;
  }
  @keyframes blink {
    0%,
    80%,
    100% {
      transform: scaleY(1);
    }
    90% {
      transform: scaleY(0.15);
    }
  }
  @keyframes glow {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .busy .eye,
    .busy .dot {
      animation: none;
    }
  }
</style>
