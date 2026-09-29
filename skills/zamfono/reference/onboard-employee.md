---
title: Onboard an employee
arguments:
  - name: employeeName
    description: The employee's full name
    required: true
  - name: email
    description: The employee's e-mail address, for the set-password link
    required: true
  - name: extension
    description: A specific extension to assign; omit to let the tenant assign the next free one
    required: false
---

# Onboard an employee

1. Create the user: `users.create` (`POST /users`) with `name`, `email` and, optionally,
   `extension`. The response carries a one-time set-password link; with no mail relay configured,
   pass that link on to the employee yourself.
2. Create their first device: `devices.create` (`POST /users/{id}/devices`).
   - With the `manual` provisioning provider, the response carries the SIP credentials once — record
     them now, or use `devices.revealCredentials` (`GET /devices/{id}/credentials`) later, which is
     audited as a reveal — and hand them to the employee for their softphone (see
     `tested-softphones`) or desk phone.
   - With `ringotel`, the credentials are pushed to Ringotel instead of returned, and the device
     onboards through Ringotel's own activation e-mail and QR code; no credentials need to be
     typed in by hand. The stack must be connected to Ringotel first (`ringotel-setup`), and a
     `warnings` entry in the response means Ringotel refused the device; it says why.
3. Set forwarding, if the role needs it, with `users.setForwarding` (`PUT /users/{id}/forwarding`) —
   the classic unconditional/busy/no-answer/DND/offline rules, each a forward target
   (`mental-model`).
4. Add the employee to any ring group they belong to via `ringGroups.update`
   (`PATCH /ringGroups/{id}`) with the group's updated `members` list.

Every step above is one audited, undoable operation (`guardrails`); a mistake in extension,
forwarding or group membership is undone with `audit.undo` (`POST /audit/{id}/undo`) rather than
redone by hand.
