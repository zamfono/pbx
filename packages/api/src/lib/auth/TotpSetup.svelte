<script lang="ts">
  import type { Dictionary } from '#lib/i18n/index.js';

  // An authenticator app's enrolment (§5.2 "Two-factor authentication"): the `otpauth` URI as a
  // QR code, rendered on the server, and the same secret as text for manual entry.
  const {
    qrSvg,
    secret,
    dict
  }: { qrSvg: string; secret: string; dict: Dictionary['mfa'] } = $props();
</script>

<!-- The markup is `qrSvg()`'s own output, made on the server from the secret it encodes; nothing
     a person typed reaches it. -->
<div class="auth-qr" role="img" aria-label={dict.qrLabel}>
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- server-generated QR markup, see above -->
  {@html qrSvg}
</div>
<p class="auth-note">{dict.secretLabel}</p>
<code class="auth-command">{secret}</code>
