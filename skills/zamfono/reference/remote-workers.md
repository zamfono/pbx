# Remote workers

Zamfono clients work from the office and from home without a VPN: devices carry NAT-friendly
settings (`rewrite_contact`, `rtp_symmetric`, `force_rport`), and media always flows through
Asterisk, which recording, presence and internal routing depend on either way.

Two things to tell a remote worker before they treat their extension as their only phone:

- **Emergency calls from a desktop app or desk phone reach the office, not them.** Dialling an
  emergency number from a home-office softphone on a computer, or from a desk phone, is answered
  by the emergency centre responsible for the company's registered address, never the worker's
  own location. The Ringotel mobile app is the exception: it dials emergency numbers through the
  phone's own cellular network, which reaches the emergency centre where the worker is. See
  `emergency-calls`.
- **A `plain`-transport device only works from an allow-listed address.** `tls` devices (the
  default for a mobile softphone) register from anywhere; a `plain` device — typically a desk
  phone kept off TLS — is restricted to its admin-configured IP allowlist, so it will not
  register at all from home unless that address is added.

For device recommendations, see `tested-softphones`.
