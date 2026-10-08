<!--
  The QR code of an authenticator app's enrolment, drawn from the otpauth URI (`qrMatrix`). Dark
  modules on a light quiet zone in both themes, as scanners expect.
-->
<script lang="ts">
  import { qrMatrix } from './mfa';

  let {
    text,
    label,
    size = 184
  }: { text: string; label: string; size?: number } = $props();

  const QUIET = 2;
  const matrix = $derived(qrMatrix(text));
  const span = $derived(matrix.length + QUIET * 2);
  const path = $derived(
    matrix
      .flatMap((line, row) =>
        line.map((dark, col) =>
          dark ? `M${col + QUIET} ${row + QUIET}h1v1h-1z` : ''
        )
      )
      .join('')
  );
</script>

<svg
  class="qr"
  width={size}
  height={size}
  viewBox="0 0 {span} {span}"
  role="img"
  aria-label={label}
  shape-rendering="crispEdges"
>
  <rect class="quiet" width={span} height={span} rx="1.2" />
  <path class="modules" d={path} />
</svg>

<style>
  .qr {
    display: block;
    flex: none;
  }
  /* Constant across themes: --on-primary is white and --on-lime near-black in light and dark. */
  .quiet {
    fill: var(--on-primary);
  }
  .modules {
    fill: var(--on-lime);
  }
</style>
