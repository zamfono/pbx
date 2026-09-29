---
title: Connect the Ringotel apps
arguments:
  - name: domain
    description: The Ringotel domain for this stack, as in `<domain>.ringotel.co`
    required: true
---

# Connect the Ringotel apps

Ringotel's desktop and mobile apps are this stack's softphones: once connected, a `ringotel`
device is pushed to Ringotel, and the employee onboards through Ringotel's activation e-mail and
QR code instead of typing SIP credentials. The owner connects the stack once.

1. Store the Ringotel Admin API key: `settings.update` (`PATCH /settings`) with `ringotelApiToken`.
   It is the account's key, so it reaches every organization in that Ringotel account, other
   customers' included; Zamfono only ever touches the one it set up or adopted.
2. Check whether the organization exists already. The domain is unique across Ringotel, so an
   organization created earlier in the Ringotel Shell, or left behind by a setup that failed,
   keeps it.
   - **New:** list the choices with `provisioning.ringotelOptions`
     (`GET /provisioning/ringotel/options`), then `provisioning.ringotelSetup`
     (`POST /provisioning/ringotel/setup`) with the `domain`, a `region` id and a `packageid` from
     that list. The region cannot be changed later; pick the one closest to the users (`3` is Europe
     (Frankfurt)). A domain the account already has is refused with the adoption call that takes it
     over.
   - **Existing:** `provisioning.ringotelAdopt` (`POST /provisioning/ringotel/adopt`) with the
     organization's `orgId` and `domain` together, and optionally the `branchId` of a connection to
     reuse. Only an organization without users is adopted, and the call asks for confirmation.

   Either way the stack's connection points at `<fqdn>:5061`, the parking slots appear as
   Ringotel users, and `ringotelMaxRegs`, the registrations per user, follows the package while
   it is still at its default.

3. Create each employee's device with `kind: "ringotel"` (`onboard-employee`). Once the device's
   SIP account reaches Asterisk, Ringotel registers it and sends the activation e-mail to the
   user's address, so the user needs one.

If Ringotel refuses a device, the device is still created and the response carries a `warnings`
entry with Ringotel's reason; `devices.rotate` (`POST /devices/{id}/rotate`) pushes it again with a
new password. Nothing is ever pushed to Ringotel before the setup or adoption: those provision the
existing `ringotel` devices when they run.
