# Recording: announcement and consent

Call recording is off by default and enabled per user or per ring group by an admin
(`users.recordCalls`, `ringGroups.recordCalls`). Once on, a call yields one stereo recording per
recorded participation: left channel the recorded user, right channel everything they heard.
Voicemail deposits, unanswered calls and feature-code service calls (`*95`, `*96`, `*97`) are
never recorded — voicemail audio is already its own record.

Recordings and voicemails are personal data. Whether a recorded call needs an announcement or a
caller's consent, and in what form, depends on the jurisdiction the tenant and its callers are
in — one-party consent in some, two-party (all-party) consent in others, plus any sector-specific
rule. Zamfono plays no recording announcement or consent prompt of its own: this is the
operator's and the tenant's responsibility to establish before turning `recordCalls` on for a
user or group, for example through a greeting on the relevant DID, an IVR prompt, or a beep
injected by the trunk provider.

`GET /recordings` and downloading a recording's audio are `admin`/`owner` only, including
recordings of a user's own calls. Recordings are purged after `settings.recordingRetentionDays`
(default 90 days) by a daily job; a shorter retention is one way to reduce exposure once a
recording has served its purpose.
