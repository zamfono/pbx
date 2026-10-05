# Emergency calls

Dialling an emergency number (`settings.emergencyNumbers`, seeded per country — `112` and
`110` for Germany, `112` alone where no country-specific list is shipped) bypasses all normal
outbound routing: no outbound route, caller list, CLIR setting or channel cap applies. The call
tries the tenant's emergency trunks in their configured priority order, skipping any marked
unreachable and failing over to the next on timeout or error; it fails, with a clear error, only
while no emergency trunk in the tenant is live. The caller's own number is always presented,
never anonymous.

## Emergency trunks

Only a trunk with `emergency` set ever carries an emergency call; every trunk states it, since
`trunks.create` (`POST /trunks`) requires the field. Set it only on a trunk whose provider routes
emergency numbers to the emergency service of the company's registered address. A trunk whose
provider is in another country than the company must not be flagged: a US provider has no use for
`112`, and a German number has no E911 record there, so the call would be rejected or reach the
wrong emergency centre. Without any flagged trunk, every emergency call fails: a trunk create,
update or delete that leaves the tenant in that state returns the warning
`no emergency trunk; emergency calls will fail`, and `GET /healthz` fails its check `trunks:emergency`
until one is flagged.

## Where the call is answered

The emergency service that answers is the one responsible for the address the trunk provider has
on file for the presented number — the company's registered address, not the caller's physical
location. A desktop softphone or a desk phone used from a home office, or from anywhere else than
the office, that dials an emergency number is answered by the office's local emergency centre, not
the caller's own.

The Ringotel mobile app is the exception. The stack gives it the tenant's emergency numbers
(`emergencyNumbers` in `settings.update`), and it dials them through the phone's own cellular
network: the call reaches the emergency centre where the person is, with the phone's location, and
works without mobile data or a reachable PBX. Such a call never passes through Zamfono, so it has
no call-history entry, uses no emergency trunk and leaves no trace.

A change to the emergency numbers is stored and in force on the PBX as soon as `settings.update`
returns, even while Ringotel is unreachable; the mobile apps get it afterwards. If Ringotel
refuses it, the response carries a `warnings` entry, `system.info` shows
`ringotel.profilePending: true` (and `/healthz` warns `ringotel:profile`), and the stack
sends it again with the next change to the apps' profile, when `api` starts or when Asterisk
restarts, until Ringotel takes all of it. Until then the apps dial the old numbers through the cellular
network, and every other device already dials the new ones through the PBX.

Tell every remote worker this before they rely on a Zamfono extension for emergencies from
somewhere other than the office (see `remote-workers`).
