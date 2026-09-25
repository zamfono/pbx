# Emergency calls

Dialling an emergency number (`settings.emergencyNumbers`, seeded per country — `112` and
`110` for Germany, `112` alone where no country-specific list is shipped) bypasses all normal
outbound routing: no outbound route, caller list, CLIR setting or channel cap applies. The call
tries the tenant's trunks in their configured priority order, skipping any marked unreachable and
failing over to the next on timeout or error; it fails, with a clear error, only while no trunk
in the tenant is live. The caller's own number is always presented, never anonymous.

## Where the call is answered

The emergency service that answers is the one responsible for the address the trunk provider has
on file for the presented number — the company's registered address, not the caller's physical
location. A softphone used from a home office, or from anywhere else than the office, that dials
an emergency number is answered by the office's local emergency centre, not the caller's own.

Tell every remote worker this before they rely on a Zamfono extension for emergencies from
somewhere other than the office (see `remote-workers`).
