# Zamfono mockup: guide for demo operators

This guide is for whoever presents the Zamfono mockup to a prospect or walks colleagues through it.
It covers how to prepare, the people and data in the demo, ready-made story lines, every scripted
Mucki conversation, what to point out, and how to recover when something goes off script.

The mockup is a clickable model of the Zamfono admin and self-service UI. It runs entirely in the
browser: there is no server, no real telephony and no real e-mail. Everything a visitor clicks
behaves the way the Zamfono API behaves, including permissions, confirmations, validation messages
and undo, so the demo is honest about what the product does.

## 1. Before the demo

| Check                 | Why                                                                                                                                                                                                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open the mockup       | https://demo.zamfono.com in a current browser. The guide is in the demo bar (**Leitfaden**) and at https://demo.zamfono.com/guide.                                                                                                                                                                  |
| **Demo zurücksetzen** | In the dark demo bar at the top. Starts from a clean Brandt & Partner with today's call history. Do this before every demo.                                                                                                                                                                         |
| Language              | Avatar menu → **Sprache** DE/EN. German is the default and the main story language.                                                                                                                                                                                                                 |
| Theme                 | Avatar menu → **Darstellung**. Light usually projects better; dark looks great on a laptop.                                                                                                                                                                                                         |
| Window width          | 1280 px or wider shows the sidebar, page and Mucki side by side. Below 1100 px Mucki becomes an overlay; below 760 px the phone layout appears.                                                                                                                                                     |
| Sound                 | Voicemails and call recordings play real (synthesised) German speech. Check the speakers.                                                                                                                                                                                                           |
| Time of day           | Routing follows the clock: incoming calls are put through during opening hours (Mon–Thu 08:00–12:30 and 13:30–17:30, Fri 08:00–14:00, Berlin) and get the closed announcement or a mailbox outside them. To show a particular situation whatever the real time, pick a **demo moment** (section 2). |

**Tip:** the visible tab is the one that simulates calls. Two tabs side by side (for example Jonas
and Mira) share the same company data and each keep their own signed-in person, which makes a
nice "admin changes it, employee sees it" moment.

## 2. The demo bar

The striped bar at the very top is not part of the product; tell the audience so.

| Control                                                    | What it does                                                                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Lea · Inhaberin / Jonas · Admin / Mira · Mitarbeiterin** | Switch the signed-in person instantly, without signing out. Each keeps their own Mucki chat.                          |
| Clock chip                                                 | The demo's date and time. Lime while a demo moment is set. Opens the **Demo-Zeitpunkt** menu (below).                 |
| **Leitfaden**                                              | Opens this guide beside the mockup. Its links (`/history?as=jonas`) open the page they name, as the person they name. |
| **Live-Simulation pausieren**                              | Freezes incoming calls, presence changes and other live events, e.g. while you explain a screen.                      |
| **Demo zurücksetzen**                                      | Restores the starting data and clears all Mucki conversations.                                                        |
| **Abmelden**                                               | Back to the sign-in screen.                                                                                           |
| Chevron                                                    | Collapses the bar to a small tab.                                                                                     |

### Demo moments

The clock chip in the demo bar restarts the demo at a chosen moment; the clock keeps running
from there, and the call history, voicemails and backups fit that moment. **Demo zurücksetzen**
returns to the start of the moment you are in.

| Moment                  | Date and time                         | Shows                                                                                             |
| ----------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Jetzt**               | The real time                         | Whatever is true right now.                                                                       |
| **Bürotag, 10:30**      | The coming Tuesday, 10:30             | A busy office morning: groups ring, colleagues answer. The best default for a tour.               |
| **Feierabend, 19:00**   | The same Tuesday, 19:00               | Closed: the main number plays the closed announcement, the hotline goes to Support's mailbox.     |
| **Zwischen den Jahren** | 29 December, 10:00                    | The holiday closure in effect: every call to the company hears the holiday announcement.          |
| **Felix im Urlaub**     | Wednesday of his vacation week, 11:00 | His out-of-office in effect: calls to his direct number ring Daniel instead; the trace shows why. |

Moments other than **Jetzt** are clearly marked: the clock chip turns lime, so nobody takes the
demo time for the real one.

Deep links take a person and Expert mode, handy for prepared bookmarks:
`/history?as=jonas`, `/settings?as=lea&expert=1`, `/me/forwarding?as=mira`.

## 3. The cast

**Brandt & Partner Steuerberatung, München**: a 14-person tax advisory.

| Person             | Role           | Ext. | Use them for                                                                                       |
| ------------------ | -------------- | ---- | -------------------------------------------------------------------------------------------------- |
| Lea Brandt         | Inhaberin      | 101  | Owner-only settings, updates, SSO, Ringotel, bulk changes. Signs in with authenticator or passkey. |
| Jonas Weber        | Admin          | 102  | The office manager's view: people, groups, hours, numbers, troubleshooting. Authenticator.         |
| Mira Kovač         | Mitarbeiterin  | 103  | Self-service: forwarding, vacation, voicemail, do-not-disturb. No second factor.                   |
| Dr. Felix Hartmann | Inhaber        | 104  | Second owner; calls are recorded; has passkeys; vacation in two weeks.                             |
| Empfang            | Mitarbeiter:in | 100  | A phone-only reception desk without e-mail; the only person without a Ringotel app.                |
| Markus Huber       | Mitarbeiter    | 120  | Usually on a call; his extension is the planned conflict in the bulk-import demo.                  |
| Petra Engel        | Mitarbeiterin  | –    | E-mail only, no extension: can log in, has no phone.                                               |

Others: Sophie Lang (106), Daniel Roth (107, recorded), Aylin Demir (108), Tobias Neumann (109, on
do-not-disturb), Laura Fischer (111), Katrin Wolf (113), Nina Schreiber (114, app not signed in).

**Numbers and routing**

- Main number **+49 89 4520 0** → phone menu **Hauptmenü** (1 Beratung, 2 Buchhaltung, 3 Support,
  0 Empfang).
- Direct dials in the block +49 89 4520 xxx; **Mandanten-Hotline +49 89 4520 500** → ring group
  **Mandanten-Support (004)**.
- Ring groups Empfang (001), Beratung (002, recorded), Buchhaltung (003), Mandanten-Support (004,
  own hours Mon–Fri 09–17, mailbox).
- One trunk, **Nordwind SIP** (TLS, SRTP), which is also the emergency trunk.
- Closure between the years (28 Dec – 2 Jan) with an announcement; Felix's vacation in two weeks.

## 4. Story lines

Pick by audience and time. Each step names what to click and what to say.

### A. First impression (3 minutes)

1. **Sign-in screen.** Brand panel with the company name, Microsoft sign-in, and the dark
   **Demo-Zugänge** panel. Click **Jonas Weber**.
2. **Second factor.** Point out that admins and owners must use two-factor sign-in. The demo
   authenticator shows a live code: **Code einsetzen**.
3. **Übersicht.** Live tiles: missed calls, new voicemails, parked calls, calls now. Admins also see
   live calls, the phone line, system health and today's call volume. Leave it a few seconds: calls
   ring in, people change presence, the bell counts events.

### B. The office manager's tour (10 minutes, Jonas)

1. **Benutzer → Benutzer anlegen.** Name, e-mail, extension (the next free one is suggested). The
   one-time set-password link appears once; add the Ringotel app right away.
2. **Ring group Mandanten-Support.** Members, ring strategy, timeouts, mailbox, hold music. Tab
   **Weiterleitung**: what happens when nobody answers.
3. **Öffnungszeiten.** Drag a block in the week grid, resize it, click it for exact times. Add a
   closure with **Abwesenheit**: it shows on the timeline and is refused if it overlaps another.
4. **Sprachmenüs → Hauptmenü.** The keypad editor: each key leads to a person, group, mailbox or
   announcement.
5. **Rufnummern.** The main number, direct dials, the number block; delete Lea's number and show the
   refusal that names who still uses it.
6. **Änderungsprotokoll.** Every change just made, by whom and how; **Rückgängig** on any of them.

### C. "Why did that call go to the mailbox?" (5 minutes, Jonas)

The strongest single moment of the demo.

1. **Anrufverlauf** → the call from **+49 171 5550123 at 10:15** to the hotline (the most recent
   weekday; today once it is past 10:20).
2. The vertical trace reads like a story: number matched, Support open, Sophie didn't answer, Mira
   was busy, Nina has no phone signed in, Tobias is on do-not-disturb, 45 s total ring time, the
   "unanswered" rule, Support's mailbox. Call quality is shown per side.
3. Turn on **Expertenmodus** in the top bar: the raw call log and the SIP message ladder appear.
4. Ask Mucki the same question (prompt in section 5): it reads the same trace, explains it in plain
   words and plays Mr Yilmaz's voicemail.

### D. Self-service on a phone (5 minutes, Mira)

Switch to **Mira** and narrow the window below 760 px, or open the link on an actual phone.

1. The bottom tab bar: Übersicht, Anrufe, Mailbox, Ich, Mucki.
2. **Mailbox**: play Elif Kaya's message, mark it heard.
3. **Ich → Weiterleitung**: rules as cards, "nach 20 Sekunden aufs Handy".
4. **Ich → Abwesenheit & Zeiten**: plan next week's vacation.
5. Point out what she cannot do: no admin pages in the menu, no call recordings (not even her own),
   no SIP targets for forwarding. Mucki explains the same limits when asked.

### E. The owner (5 minutes, Lea)

1. **Einstellungen**: Lea edits the mail relay, SSO, emergency numbers and retention; switch to
   Jonas and show the same cards as read-only text, with credentials hidden.
2. **System & Updates**: version 0.5.0 is available. An update needs a successful backup from the
   last hour: **Zu den Backups** → run a backup (about 5 s) → **Jetzt aktualisieren** → maintenance
   banner (about 6 s) → 0.5.0. Or let Mucki do it (prompt 7).
3. **KI & API**: connect Claude Code or Codex with one command; webhooks for the CRM.

### F. Expert mode (2 minutes, any admin)

The **Expertenmodus** switch in the top bar reveals every configuration option the system has,
marked **Experte**: codecs, SIP ban thresholds, trunk timers and TLS options, device IP allowlists,
diagnostics levels, raw call logs, SIP traces, entity IDs, and the extra **SIP-Schutz** page. Off,
the same screens show only what an office manager needs. Message: one product for the office
manager and the IT partner.

### G. After hours, holidays, vacation (5 minutes, Jonas)

1. Demo bar clock → **Feierabend, 19:00**. **Öffnungszeiten** shows the company closed until Wednesday morning.
   Wait for a call or two, then open **Anrufverlauf**: the trace shows the schedule closed and the
   call sent to the closed announcement or Support's mailbox.
2. Clock → **Zwischen den Jahren**: the holiday closure is active; calls hear the holiday
   announcement.
3. Clock → **Felix im Urlaub**: calls to Felix's direct number are forwarded to Daniel; his user
   page shows the running out-of-office.
4. Back to **Bürotag, 10:30** to continue.

## 5. Mucki, the assistant

Mucki is the coral panel on the right (on phones: the **Mucki** tab). It acts as the signed-in
person, with exactly their permissions: everything it changes appears in the screens at once and in
the audit log as made through Mucki, and can be undone. Confirmation cards appear before anything
irreversible or destructive; nothing happens until **Bestätigen**.

Drive it with the suggestion chips (they change with the person and the page) or type freely in
German or English. Anything outside the scripts gets a friendly answer listing what it can do.
**Neues Gespräch** clears the chat for the current person.

| #   | Person | Say (DE)                                                                                               | What happens                                                                                                                                            | Point at                                             |
| --- | ------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | Jonas  | „Neue Mitarbeiterin anlegen“ → chip „Tom Becker, tom.becker@brandt-partner.de, Durchwahl 105, mit App“ | Creates Tom, shows his one-time password link, adds the Ringotel app.                                                                                   | **Zeig mal** jumps to Tom with the row highlighted.  |
| 2   | Jonas  | „Schließ den Support am 24.–26.12., Anrufe auf die Mailbox“                                            | Checks for overlapping closures, then plans the closure for Mandanten-Support.                                                                          | The ring group's schedule tab.                       |
| 3   | Jonas  | „Mach das rückgängig“                                                                                  | Finds its last change in the audit log and undoes it.                                                                                                   | Änderungsprotokoll: the original entry and the undo. |
| 4   | Jonas  | „Warum ist der Anruf von +49 171 5550123 um 10:15 auf der Mailbox gelandet?“                           | Reads the call and explains the trace in plain words; offers to play the voicemail.                                                                     | The call detail page (Zeig mal).                     |
| 5   | Jonas  | „Ist unser Trunk ok?“                                                                                  | Checks the line; if it is down, offers to re-register it and confirms when it is back.                                                                  | Best right after the line drops (section 7).         |
| 6   | Lea    | „8 neue Leute aus einer Liste anlegen“ → paste chip                                                    | Creates seven people with a progress card; one row wants Markus's extension 120 and is reported, then Mucki offers a free extension.                    | Users list with the new people.                      |
| 7   | Lea    | „Update Zamfono“                                                                                       | Checks the version, finds no recent backup, runs one, waits, asks to confirm the update, then reports 0.5.0.                                            | System & Updates.                                    |
| 8   | Lea    | „Leite die Hotline an unseren KI-Telefonagenten weiter“                                                | Asks for the agent's address (chip `sip.voiceagent.example`), adds a SIP connection "KI-Telefonagent" and points the hotline at it with caller headers. | Rufnummern: the hotline now goes to the AI agent.    |
| 9   | Mira   | „Leite meine Anrufe nach 20 Sekunden aufs Handy“                                                       | Asks for the mobile number (chip), sets 20 s ring time and the "no answer" forwarding.                                                                  | Ich → Weiterleitung.                                 |
| 10  | Mira   | „Ich bin nächste Woche im Urlaub“                                                                      | Asks where calls should go (mailbox, Sophie, Empfang) and plans Monday to Saturday.                                                                     | Ich → Abwesenheit & Zeiten.                          |
| 11  | Mira   | „Spiel mir die Aufnahme meines letzten Gesprächs vor“                                                  | Politely refuses: only admins may hear recordings. Offers her latest voicemail instead and plays it.                                                    | The role limit is the point.                         |

English works too ("Why did the call from +49 171 5550123 at 10:15 go to voicemail?", "Update
Zamfono", "I'm on vacation next week", …). With **Expertenmodus** on, Mucki's tool cards show the
exact operation it called with its input and result, which is good for technical audiences.

## 6. Talking points

- **Nothing to install.** The admin UI runs in the browser; staff use the Ringotel app or a desk
  phone.
- **Every change is recorded and can be undone**, whether made in the UI or by an AI assistant,
  with who and how.
- **Roles that match a small office**: owner, admin, employee. Owners keep the critical settings;
  employees manage their own phone and see nothing else.
- **Explains itself.** The call trace answers "why did that happen?" without a technician.
- **Calm by default, complete in Expert mode.** Office managers see the essentials; an IT partner
  finds every option.
- **AI assistant built in**, acting as the person, with the same rights and the same safety nets;
  any MCP client (Claude, Codex) can connect the same way.
- **Security**: two-factor sign-in with authenticator or passkeys, Microsoft sign-in, SIP brute-force
  protection with automatic bans, call recordings only for admins.
- **Live**: presence, ringing calls, voicemails and line status update without reloading.

## 7. What is simulated, and how to recover

| Situation                                    | What to know                                                                                                                                                                                                                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The phone line drops                         | About 75 s after the demo starts, **Nordwind SIP** becomes unreachable once: running external calls end as interrupted, no new ones arrive, colleagues keep calling each other. Use it for prompt 5, or **SIP-Trunks → Neu anmelden**. It recovers by itself after 5 minutes. |
| Calls and presence change by themselves      | That is the live simulation. Pause it in the demo bar while explaining a busy screen.                                                                                                                                                                                         |
| Voices                                       | Voicemails and recordings are synthesised; the callers are fictional. Recordings are stereo: left the colleague, right the other party (switchable in the player).                                                                                                            |
| Passwords and codes                          | Any password works for the demo accounts; any six digits pass the second factor (or use **Code einsetzen**).                                                                                                                                                                  |
| E-mails, Ringotel, backups, updates          | Nothing leaves the browser. Mails show a confirmation, backups and updates take a few seconds and succeed.                                                                                                                                                                    |
| Audio library                                | Every greeting, mailbox greeting, announcement and hold-music track plays; click the waveform to jump. The hold music is the opsound set Zamfono ships (CC BY-SA, credited in the admin guide). Uploads play until the page is reloaded.                                      |
| The data looks messy after a try-out         | **Demo zurücksetzen**.                                                                                                                                                                                                                                                        |
| A tab shows a different person than expected | Each tab keeps its own person; use the demo bar or a `?as=` link.                                                                                                                                                                                                             |
| Changes vanish after closing the browser     | The demo keeps its state in the browser's storage; private windows or blocked site data start fresh each time. It still works, it just doesn't remember.                                                                                                                      |
| Mucki was interrupted (reload mid-answer)    | The card shows "Unterbrochen"; ask again or start **Neues Gespräch**.                                                                                                                                                                                                         |

## 8. Questions prospects ask

- **"Is this the real product?"** It is a clickable model of the Zamfono UI, built against the real
  API: the rules, permissions and messages are the product's.
- **"Can I keep my numbers?"** Numbers come from the SIP provider behind the trunk; Zamfono routes
  whatever the provider delivers, including number blocks.
- **"What phones work?"** The Ringotel app on iOS, Android and desktop, plus standard SIP desk
  phones (**Telefon hinzufügen** shows the connection data).
- **"Where does the AI run?"** Mucki uses the same interface any AI client uses, signed in as the
  person; it can do nothing that person couldn't.
