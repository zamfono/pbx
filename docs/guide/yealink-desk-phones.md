# Yealink desk phones

A Yealink desk phone is a device of kind `yealink`: it fetches its whole configuration from a
**provisioning link** instead of being set up by hand, and fetches it again every night, so later
changes reach it on their own: a rotated password, a renamed extension, a changed key list, new
codecs or a new time zone. Tested on the Yealink T87W (T8x/T7x firmware).

## Set up a phone

1. Create the device: `devices.create` (`POST /api/v1/users/{id}/devices`) with `kind: yealink`,
   always `tls`: SIP over TLS with SRTP, from anywhere (`plain` is for `manual` devices). The
   answer's `provisioningLink`, `https://<FQDN>/provision/<token>/`,
   is shown once, next to the connection settings.
2. On the phone's web interface (its address is on the phone's status screen; factory login
   `admin` / `admin`): **Settings → Auto Provision**, paste the link into **Server URL**, leave
   user name and password empty, save, then **Auto Provision Now**. The phone takes its new
   configuration and registers.
3. From its first fetch on, the phone's web interface asks for the admin password Zamfono
   generated with the device: `adminPassword` in the connection settings, which
   `devices.revealCredentials` (`GET /api/v1/devices/{id}/credentials`) returns again later.

The device record shows when and from which address the phone last fetched its file
(`provisionedAt`, `provisionedFrom`).

## What the link sets

- The account: server and port, SIP over TLS with SRTP compulsory, SIP username and password, the user's name, the device's label, the tenant's codecs in order with every other
  codec off. The T87W has no Opus, so the phone offers the tenant's other codecs: keep G.722 or
  G.711 in the list.
- The voicemail key dials the own-voicemail code. The message lamp counts the user's own mailbox
  alone, so it promises only what that key opens; ring-group mailboxes go on mailbox keys (below).
  To count some or all groups' mailboxes on the lamp too, set the device's `mwiRingGroups` with
  `devices.update` (a list of ring-group ids, or `null` for every group the user belongs to).
- The phone's own **do not disturb** and **call forwarding** are off, since both live in Zamfono,
  where lamps, the API and forwarding rules see them: give the phone a `dndToggle` key, and set
  forwarding with `users.setForwarding`.
- **Line keys** from the device's key list, in order from the first key: `devices.setBlf`
  (`PUT /api/v1/devices/{id}/blf`) takes
  - `{"kind": "line"}`: the account's line key, which shows the registration and the calls; at
    most one, usually first;
  - `{"kind": "blf", "ext": "205"}`: a BLF key on a user, ring group or parking slot, whose lamp
    shows its state; pressed while it rings, a user's or group's key picks the call up, a slot's
    retrieves the call parked there;
  - `{"kind": "quickDial", "number": "+43123456789", "label": "Taxi"}`: a quick-dial key to an
    outside number (E.164);
  - `{"kind": "feature", "feature": "dndToggle", "label": "DND"}`: the DND key. Its lamp is lit
    while the user's DND is on, however it was set (this key, `*90`/`*91`, the API, another
    device), and pressing it toggles DND. DND belongs to the user, so it silences all of their
    devices, the mobile app included;
  - `{"kind": "mailbox", "ext": "600", "label": "Support VM"}`: a mailbox key, for the user's own
    mailbox or a ring group's they belong to. Its lamp is lit while the mailbox holds new
    messages, and pressing it opens the mailbox;
  - `{"kind": "feature", "feature": "park", "label": "Park"}` (or `ownVoicemail`): a key dialling
    that feature code (pressed during a call, `park` parks it and the phone hears the slot
    number).

  A new device starts with two keys: its line key and a DND key labelled "DND". Every key after
  the list is emptied; an empty list leaves no keys at all.

- The tenant's time zone and language, and the device's ringtone (`devices.update` with
  `ringtone`, one of the phone's built-in ones; `null` is the phone's own choice).
- Security: certificates are checked for the fetch and for SIP-TLS, SIP requests are accepted only
  from the server, and the web interface takes the generated admin password.
- Zamfono's own STUN server (`<FQDN>:3478`), a nightly fetch, and no blinking power LED in
  power-saving mode.

Left on the phone: its network (VLAN, 802.1X, Wi-Fi, static addresses — a wrong value would strand
it), volumes and brightness, its own call list, firmware, and dial plans, since Zamfono routes
every call, emergency calls included.

## Keep the link secret

The link is as sensitive as the SIP password: anyone holding it can fetch the phone's file with
both passwords in it. It is never shown again. A new one from `devices.provisioningLink`
(`POST /api/v1/devices/{id}/provisioningLink`, admin, audited) replaces it at once and the phone
fetches from the old one no more, so enter the new link on the phone. Deleting the device revokes
its link.

## The admin password outlives the device

A phone keeps the generated admin password after its device is deleted. To reuse the phone
elsewhere, reveal the password before deleting the device, or reset the phone to factory settings
from its advanced settings.

## Old firmware and certificates

Zamfono's certificate comes from Let's Encrypt, whose root (ISRG Root X1) current Yealink firmware
trusts. Old firmware may lack it, so both the link and SIP-TLS fail with a certificate error.
Update the firmware first. As a last resort, untick **Only Accept Trusted Certificates** under
**Security → Trusted Certificates** for the first fetch; the link's file switches the check back
on, so the firmware update is still needed.
