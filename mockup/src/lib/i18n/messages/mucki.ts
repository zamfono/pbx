/**
 * Mucki: the panel, the tool and confirmation cards, and the eleven scripted conversations (§6.2).
 */
import type { Messages } from '../index.svelte';

export default {
  de: {
    'mucki.title': 'Mucki',
    'mucki.actsAs': 'handelt als {name} ({role})',
    'mucki.panel': 'Mucki, dein Assistent',
    'mucki.newConversation': 'Neues Gespräch',
    'mucki.close': 'Mucki schließen',
    'mucki.resize': 'Breite von Mucki ändern',
    'mucki.placeholder': 'Frag Mucki oder sag, was du brauchst …',
    'mucki.send': 'Senden',
    'mucki.thinking': 'denkt nach …',
    'mucki.composerHint': 'Enter sendet · Shift+Enter neue Zeile',
    'mucki.disclaimer':
      'Mucki arbeitet mit deinen Rechten. Jede Änderung steht im Audit-Log.',
    'mucki.suggestions': 'Vorschläge',
    'mucki.welcome.user':
      'Hallo {name}! Ich bin **Mucki**. Ich kümmere mich um dein Telefon: Weiterleitungen, Abwesenheiten, deine Mailbox. Was darf ich tun?',
    'mucki.welcome.admin':
      'Hallo {name}! Ich bin **Mucki**, dein Assistent für die Telefonanlage. Ich lege Leute an, plane Schließzeiten, erkläre, was mit einem Anruf passiert ist – und mache alles auf Wunsch wieder rückgängig.',
    'mucki.welcome.owner':
      'Hallo {name}! Ich bin **Mucki**. Ich übernehme auch die großen Sachen: viele neue Kolleg:innen auf einmal, das Update der Anlage oder die Hotline für euren KI-Telefonagenten.',
    'mucki.showMe': 'Zeig mal',
    'mucki.showMeLabel': 'Öffnet {label}',
    'mucki.none': 'keine',
    'mucki.and': 'und',
    'mucki.ok': 'Alles klar, dann lasse ich das so.',
    'mucki.cancelled': 'Okay, abgebrochen – ich habe nichts geändert.',
    'mucki.fallback':
      'Das kann ich leider noch nicht. Ich erfinde lieber nichts – aber hierbei helfe ich dir gern:',

    'mucki.chip.no': 'Nein',
    'mucki.chip.noThanks': 'Nein, danke',
    'mucki.chip.cancel': 'Abbrechen',
    'mucki.chip.later': 'Später',
    'mucki.chip.play': 'Ja, vorspielen',

    'mucki.tool.running': 'Arbeite …',
    'mucki.tool.done': 'Erledigt',
    'mucki.tool.awaiting': 'Wartet auf deine Bestätigung',
    'mucki.tool.cancelled': 'Abgebrochen, nichts geändert',
    'mucki.tool.interrupted': 'Unterbrochen',
    'mucki.tool.refused': 'Für deine Rolle nicht freigegeben',
    'mucki.tool.missing': 'Das steht hier noch nicht zur Verfügung',
    'mucki.tool.state.running': 'läuft',
    'mucki.tool.state.awaiting': 'wartet',
    'mucki.tool.state.done': 'fertig',
    'mucki.tool.state.refused': 'abgelehnt',
    'mucki.tool.state.error': 'Fehler',
    'mucki.tool.state.cancelled': 'abgebrochen',
    'mucki.tool.input': 'Eingabe',
    'mucki.tool.result': 'Ergebnis',
    'mucki.tool.details': 'Details',

    'mucki.confirm.label': 'Bestätigung nötig',
    'mucki.confirm.cancel': 'Abbrechen',
    'mucki.confirm.confirmed': 'Bestätigt',
    'mucki.confirm.cancelled': 'Abgebrochen',
    'mucki.confirm.irreversible': 'Das lässt sich nicht rückgängig machen.',
    'mucki.confirm.nothingYet': 'Es passiert erst, wenn du bestätigst.',

    'mucki.secret.label': 'Wird nur einmal angezeigt',
    'mucki.progress.done': 'angelegt',
    'mucki.progress.failed': 'fehlgeschlagen',
    'mucki.refusal.title': 'Darf ich nicht',
    'mucki.error.title': 'Hat nicht geklappt',

    'mucki.refusal.role':
      'Das darf ich für dich nicht tun – ich arbeite immer mit deinen Rechten, und als {role} ist das nicht freigegeben. {who}',
    'mucki.refusal.askAdmin':
      'Frag am besten Jonas Weber oder Lea Brandt, die können das übernehmen.',
    'mucki.refusal.askOwner': 'Das kann nur Lea Brandt als Inhaberin.',
    'mucki.refusal.notForRole':
      'Dabei kann ich dir als {role} leider nicht helfen.',
    'mucki.refusal.generic':
      'Das darf ich mit deinen Rechten leider nicht tun. Frag am besten jemanden aus der Administration.',
    'mucki.error.failed': 'Das hat nicht geklappt: {reason}',
    'mucki.error.missing':
      'Das kann ich hier leider noch nicht erledigen. Ich habe nichts verändert.',
    'mucki.error.unexpected':
      'Da ist bei mir etwas schiefgelaufen. Versuch es gern noch einmal.',

    'mucki.target.ringGroup': 'die Rufgruppe **{name}**',
    'mucki.target.mailbox': 'die Mailbox **{name}**',
    'mucki.target.ownMailbox': 'deine **Mailbox**',
    'mucki.target.sip': 'den SIP-Anschluss **{user}** über **{trunk}**',

    'mucki.prompt.onboard': 'Neue Mitarbeiterin anlegen',
    'mucki.prompt.batch': '8 neue Leute aus einer Liste anlegen',
    'mucki.prompt.closure':
      'Schließ den Support am 24.–26.12., Anrufe auf die Mailbox',
    'mucki.prompt.undo': 'Mach das rückgängig',
    'mucki.prompt.diagnose':
      'Warum ist der Anruf von +49 171 5550123 um 10:15 auf der Mailbox gelandet?',
    'mucki.prompt.trunk': 'Ist unser Trunk ok?',
    'mucki.prompt.update': 'Update Zamfono',
    'mucki.prompt.aiAgent':
      'Leite die Hotline an unseren KI-Telefonagenten weiter',
    'mucki.prompt.forwardMobile':
      'Leite meine Anrufe nach 20 Sekunden aufs Handy',
    'mucki.prompt.vacation': 'Ich bin nächste Woche im Urlaub',
    'mucki.prompt.lastRecording':
      'Spiel mir die Aufnahme meines letzten Gesprächs vor',

    'mucki.op.users.list': 'Lese die Benutzerliste',
    'mucki.op.users.create': 'Lege die Person an',
    'mucki.op.users.update': 'Ändere das Profil',
    'mucki.op.users.getForwarding': 'Lese deine Weiterleitungen',
    'mucki.op.users.setForwarding': 'Speichere die Weiterleitungen',
    'mucki.op.devices.create': 'Richte das Gerät ein',
    'mucki.op.ooo.list': 'Prüfe bestehende Abwesenheiten',
    'mucki.op.ooo.create': 'Lege die Abwesenheit an',
    'mucki.op.audit.list': 'Suche im Audit-Log',
    'mucki.op.audit.undo': 'Mache die Änderung rückgängig',
    'mucki.op.calls.list': 'Durchsuche die Anrufliste',
    'mucki.op.calls.get': 'Lese den Anrufverlauf',
    'mucki.op.trunks.list': 'Prüfe die Trunks',
    'mucki.op.trunks.reregister': 'Registriere den Trunk neu',
    'mucki.op.trunks.create': 'Lege den Trunk an',
    'mucki.op.dids.list': 'Lese die Rufnummern',
    'mucki.op.dids.update': 'Ändere das Ziel der Rufnummer',
    'mucki.op.system.info': 'Prüfe Version und Updates',
    'mucki.op.system.update': 'Starte das Update',
    'mucki.op.backups.runs.list': 'Prüfe die letzten Sicherungen',
    'mucki.op.backups.targets.list': 'Lese die Sicherungsziele',
    'mucki.op.backups.runs.start': 'Starte eine Sicherung',
    'mucki.op.backups.runs.get': 'Warte auf die Sicherung',
    'mucki.op.recordings.list': 'Suche Aufzeichnungen',
    'mucki.op.recordings.audio': 'Hole die Aufzeichnung',
    'mucki.op.voicemails.list': 'Lese die Mailbox',
    'mucki.op.voicemails.audio': 'Hole die Sprachnachricht',

    'mucki.entry.users.create': 'das Anlegen der Person',
    'mucki.entry.devices.create': 'das neue Gerät',
    'mucki.entry.ooo.create': 'die geplante Abwesenheit',
    'mucki.entry.ooo.update': 'die Änderung an der Abwesenheit',
    'mucki.entry.ooo.delete': 'das Löschen der Abwesenheit',
    'mucki.entry.trunks.create': 'den neuen Trunk',
    'mucki.entry.dids.update': 'das neue Ziel der Rufnummer',
    'mucki.entry.users.setForwarding': 'die Weiterleitungen',
    'mucki.entry.users.update': 'die Profiländerung',
    'mucki.entry.other': 'die letzte Änderung',

    'mucki.onboard.ask':
      'Gern! Wie heißt die neue Person, welche E-Mail-Adresse und welche Durchwahl bekommt sie?',
    'mucki.onboard.sample':
      'Tom Becker, tom.becker@brandt-partner.de, Durchwahl 105, mit App',
    'mucki.onboard.incomplete':
      'Dafür brauche ich mindestens den Namen und eine E-Mail-Adresse oder Durchwahl. Probier es z. B. mit „Tom Becker, tom.becker@brandt-partner.de, Durchwahl 105“.',
    'mucki.onboard.plan':
      'Alles klar: Ich lege **{name}** als Mitarbeiter:in an – E-Mail {email}, Durchwahl **{extension}**.',
    'mucki.onboard.created': '{name} angelegt, Durchwahl {extension}',
    'mucki.onboard.linkLabel': 'Link zum Passwort-Festlegen',
    'mucki.onboard.linkNote': 'Ging auch per Mail an {email}. 7 Tage gültig.',
    'mucki.onboard.askApp':
      'Soll {name} gleich die Ringotel-App aufs Handy bekommen?',
    'mucki.onboard.appYes': 'Ja, mit App',
    'mucki.onboard.deviceCreated': 'Gerät „{label}“ eingerichtet',
    'mucki.onboard.deviceOk':
      'Die App ist eingerichtet: Ringotel schickt eine Aktivierungs-Mail mit QR-Code, Zugangsdaten muss niemand abtippen.',
    'mucki.onboard.deviceWarning':
      'Das Gerät ist angelegt, aber Ringotel meldet: {warning}',
    'mucki.onboard.done':
      'Fertig! **{name}** ist erreichbar unter Durchwahl **{extension}**.{link}',
    'mucki.onboard.doneLink':
      ' Den Link oben kannst du auch direkt weitergeben.',

    'mucki.closure.noGroup': 'Ich habe keine passende Rufgruppe gefunden.',
    'mucki.closure.listed': 'Abwesenheiten bei {name}: {count}',
    'mucki.closure.overlap':
      'Für **{name}** gibt es schon eine Abwesenheit vom {from} bis {to}, die sich damit überschneidet. Aktive Zeiträume dürfen sich nicht überlappen – schau sie dir am besten kurz an.',
    'mucki.closure.created': 'Schließung für {name} angelegt',
    'mucki.closure.done':
      'Erledigt: Die Rufgruppe **{name}** ist vom **{from} bis {to}** geschlossen. Anrufe landen in der Mailbox von {name}, ab dem {reopen} läuft alles wieder normal.{mailboxNote}',
    'mucki.closure.mailboxOff':
      ' Achtung: Die Mailbox von {name} ist ausgeschaltet.',
    'mucki.closure.link': 'Zeitplan von {name}',

    'mucki.undo.listed': 'Meine Änderungen gefunden: {count}',
    'mucki.undo.nothing':
      'Ich habe in diesem Gespräch nichts geändert, was ich rückgängig machen könnte.',
    'mucki.undo.found':
      'Meine letzte Änderung war {what} ({when}). Die nehme ich zurück.',
    'mucki.undo.reverted': 'Änderung zurückgenommen',
    'mucki.undo.done':
      'Erledigt – {what} ist rückgängig gemacht. Im Audit-Log steht jetzt ein Undo-Eintrag dazu.',
    'mucki.undo.more':
      'Davor habe ich noch mehr geändert ({count}). Sag einfach nochmal „Mach das rückgängig“.',
    'mucki.undo.later':
      'Das geht noch nicht: Danach wurde derselbe Eintrag noch geändert. Erst das hier zurücknehmen:\n{refs}',
    'mucki.undo.failed': 'Das ließ sich nicht rückgängig machen. {reason}',
    'mucki.undo.link': 'Audit-Log',

    'mucki.diagnose.listed': 'Eingehende Anrufe gefunden: {count}',
    'mucki.diagnose.read': 'Verlauf mit {lines} Schritten gelesen',
    'mucki.diagnose.notFound':
      'Ich finde in den letzten sieben Tagen keinen passenden Anruf von {caller}.',
    'mucki.diagnose.summary':
      'Ich habe den Anruf gefunden ({day}, {time}). So ist er gelaufen:',
    'mucki.diagnose.entry':
      'Um {time} rief **{caller}** die **{did}** ({number}) an.',
    'mucki.diagnose.company': 'die Firma',
    'mucki.diagnose.group': 'die Rufgruppe {name}',
    'mucki.diagnose.open':
      'Keine Abwesenheit aktiv, laut Öffnungszeiten **geöffnet**: {who}.',
    'mucki.diagnose.closed': 'Laut Öffnungszeiten **geschlossen**: {who}.',
    'mucki.diagnose.ooo': 'Eine **Abwesenheit** galt für {who}.',
    'mucki.diagnose.greeting': 'Zuerst lief die Begrüßungsansage.',
    'mucki.diagnose.ringGroup':
      'Dann klingelte die Rufgruppe **{name}** ({strategy}).',
    'mucki.diagnose.strategy.simultaneous': 'alle gleichzeitig',
    'mucki.diagnose.strategy.sequential': 'der Reihe nach',
    'mucki.diagnose.strategy.random': 'in zufälliger Reihenfolge',
    'mucki.diagnose.members': 'Bei den Mitgliedern:',
    'mucki.diagnose.noAnswer':
      '{who}: hat {seconds} s geklingelt, nicht abgenommen',
    'mucki.diagnose.noDevice': '{who}: kein Telefon angemeldet',
    'mucki.diagnose.rung': '{who}: hat geklingelt',
    'mucki.diagnose.skippedBusy':
      '{who}: übersprungen – war gerade im Gespräch',
    'mucki.diagnose.skippedDnd': '{who}: übersprungen – „Nicht stören“ war an',
    'mucki.diagnose.answered': '{who} hat abgenommen.',
    'mucki.diagnose.ringTotal':
      'Nach insgesamt **{seconds} Sekunden** ohne Annahme',
    'mucki.diagnose.forward':
      'griff die Regel „{condition}“ und leitete auf {target} weiter.',
    'mucki.diagnose.condition.unanswered': 'unbeantwortet',
    'mucki.diagnose.condition.unavailable': 'niemand erreichbar',
    'mucki.diagnose.condition.noAnswer': 'keine Antwort',
    'mucki.diagnose.condition.busy': 'besetzt',
    'mucki.diagnose.mailbox': 'Der Anruf landete in der Mailbox **{name}**.',
    'mucki.diagnose.endedCaller': 'Der Anrufer legte nach {duration} auf.',
    'mucki.diagnose.ended': 'Das Gespräch endete nach {duration}.',
    'mucki.diagnose.verdict':
      '**Kurz gesagt:** Die Anlage hat alles richtig gemacht – in {name} war schlicht niemand frei, der abnehmen konnte.',
    'mucki.diagnose.qosGood':
      'Die Verbindung war einwandfrei (Jitter {jitter} ms, Verlust {loss} %, Laufzeit {rtt} ms).',
    'mucki.diagnose.qosBad':
      'Die Verbindung war wackelig (Jitter {jitter} ms, Verlust {loss} %, Laufzeit {rtt} ms) – das kann man hören.',
    'mucki.diagnose.qosNone':
      'Zur Sprachqualität liegen für diesen Anruf keine Messwerte vor.',
    'mucki.diagnose.link': 'Anruf im Verlauf',
    'mucki.diagnose.offerPlay':
      'Der Anrufer hat eine Nachricht hinterlassen. Soll ich sie dir vorspielen?',

    'mucki.voicemail.listed': 'Sprachnachrichten: {count}',
    'mucki.voicemail.none': 'Ich finde dazu keine Sprachnachricht.',
    'mucki.voicemail.title': 'Nachricht von {caller}, {time}',
    'mucki.voicemail.latest':
      'Deine neueste Nachricht: von **{caller}**, {day} um {time}, {duration} lang.',
    'mucki.voicemail.link': 'Mailbox',
    'mucki.audio.link': 'Download-Link erstellt (5 Minuten gültig)',

    'mucki.trunk.listed': 'Trunks geprüft: {count}',
    'mucki.trunk.status.registered':
      '**{name}**: angemeldet und bereit, seit {time} ({since}).',
    'mucki.trunk.status.unreachable':
      '**{name}** ist gerade **nicht erreichbar** (seit {time}). Ausgehende Anrufe darüber klappen im Moment nicht.',
    'mucki.trunk.status.unmonitored':
      '**{name}**: wird nicht überwacht – Anrufe gehen trotzdem raus.',
    'mucki.trunk.status.unknown': '**{name}**: Status noch unbekannt.',
    'mucki.trunk.allGood': 'Alles gut, eure Leitung steht:',
    'mucki.trunk.ipTrunk':
      '{name} meldet sich nicht per Registrierung an, sondern wird über die IP-Adresse erkannt. Neu anmelden geht da nicht – am besten beim Anbieter nachfragen.',
    'mucki.trunk.offer':
      'Meist hilft es, die Registrierung beim Anbieter neu anzustoßen. Soll ich das machen?',
    'mucki.trunk.reregister': 'Ja, neu registrieren',
    'mucki.trunk.reregistered': 'Neu-Registrierung bei {name} angestoßen',
    'mucki.trunk.waiting': 'Warte auf die Anmeldung …',
    'mucki.trunk.checked': 'Wieder angemeldet',
    'mucki.trunk.back':
      'Geschafft: **{name}** ist seit {time} wieder angemeldet. Telefonieren nach draußen klappt wieder.',
    'mucki.trunk.stillDown':
      '**{name}** ist noch nicht wieder angemeldet. Ich würde ein paar Minuten warten und dann beim Anbieter nachfragen.',

    'mucki.batch.askPaste':
      'Gern! Füg die Liste einfach ein – eine Person pro Zeile: Name; E-Mail; Durchwahl.',
    'mucki.batch.sampleChip': 'Beispiel-Liste einfügen (8 Zeilen)',
    'mucki.batch.noRows':
      'Ich konnte darin keine Zeilen der Form „Name; E-Mail; Durchwahl“ erkennen.',
    'mucki.batch.confirm':
      'Ich habe **{count} Personen** erkannt:\n\n{rows}\n\nAlle bekommen die Rolle Mitarbeiter:in und per Mail einen Link zum Passwort-Festlegen. Soll ich loslegen?',
    'mucki.batch.go': 'Ja, alle anlegen',
    'mucki.batch.progress': '{done} / {total} angelegt',
    'mucki.batch.extTaken': 'Durchwahl {extension} gehört schon {owner}',
    'mucki.batch.parking': 'einem Parkplatz',
    'mucki.batch.summary': '**{done} von {total}** angelegt.',
    'mucki.batch.failures': 'Nicht angelegt:',
    'mucki.batch.links':
      'Alle Neuen haben ihren Link zum Passwort-Festlegen per Mail bekommen.',
    'mucki.batch.link': 'Benutzerliste',
    'mucki.batch.offerFree':
      'Soll ich **{name}** stattdessen mit der freien Durchwahl **{extension}** anlegen?',
    'mucki.batch.useFree': 'Ja, mit {extension}',
    'mucki.batch.retryDone':
      'Erledigt: **{name}** hat Durchwahl **{extension}**. Damit sind es {done} von {total}.',

    'mucki.update.info': 'Läuft auf Version {current}',
    'mucki.update.running':
      'Gerade läuft schon ein Update. Ich warte lieber, bis es fertig ist.',
    'mucki.update.current':
      'Ihr seid auf dem neuesten Stand: Version **{current}**.',
    'mucki.update.breaking':
      'Version **{latest}** enthält größere Änderungen. Sie wird direkt auf dem Server eingespielt, nicht über mich – am besten von der Person, die euren Server betreut, nach einem Blick in die Hinweise zur neuen Version.',
    'mucki.update.available':
      'Es gibt ein Update: **{current} → {latest}** (veröffentlicht am {published}).',
    'mucki.update.ownerOnly':
      'Das Update darf nur eine Inhaberin auslösen – frag am besten Lea Brandt. Ich kann dir aber sagen, was drin ist.',
    'mucki.update.runs': 'Sicherungen gefunden: {count}',
    'mucki.update.needBackup':
      'Vor einem Update braucht es eine erfolgreiche Sicherung aus der letzten Stunde – die letzte war am {lastDay} um {last}. Ich starte eine.',
    'mucki.update.targets': 'Sicherungsziele: {count}',
    'mucki.update.noTarget':
      'Es ist kein Sicherungsziel eingeschaltet. Richte bitte zuerst eins ein.',
    'mucki.update.backupStarted': 'Sicherung auf „{target}“ gestartet',
    'mucki.update.backupWaiting': 'Sicherung auf „{target}“ läuft …',
    'mucki.update.backupOk': 'Sicherung fertig ({size} neu)',
    'mucki.update.backupFailedShort': 'Sicherung fehlgeschlagen',
    'mucki.update.backupFailed':
      'Die Sicherung ist fehlgeschlagen: {error}. Ohne Sicherung starte ich kein Update.',
    'mucki.update.timeout': 'sie wurde nicht rechtzeitig fertig',
    'mucki.update.backupDone':
      'Sicherung auf **{target}** ist fertig (Snapshot `{snapshot}`). Jetzt das Update – bitte bestätige es kurz.',
    'mucki.update.backupRecent':
      'Es gibt eine frische Sicherung von {time}. Jetzt das Update – bitte bestätige es kurz.',
    'mucki.update.started': 'Update auf {latest} gestartet',
    'mucki.update.maintenance':
      'Die Anlage ist jetzt im **Wartungsmodus**. Laufende Gespräche brechen kurz ab, in ein bis zwei Minuten ist alles wieder da.',
    'mucki.update.waiting': 'Wartungsmodus – warte auf den Neustart …',
    'mucki.update.slow':
      'Das Update dauert länger als gewohnt. Den Stand siehst du unter System & Updates.',
    'mucki.update.done':
      'Fertig! Zamfono läuft jetzt mit Version **{latest}** (neu gestartet um {at}).',

    'mucki.agent.askHost':
      'Gern! Unter welcher SIP-Adresse ist euer KI-Telefonagent erreichbar?',
    'mucki.agent.noHost':
      'Daraus konnte ich keine SIP-Adresse lesen. Ein Hostname wie `sip.voiceagent.example` reicht.',
    'mucki.agent.dids': 'Rufnummern gelesen: {count}',
    'mucki.agent.noHotline': 'Ich finde keine Hotline-Nummer.',
    'mucki.agent.plan':
      'Die **{label}** ({number}) geht im Moment an {previous}. Ich lege dafür einen Trunk **{trunk}** zu `{host}` an und leite die Nummer dorthin weiter.',
    'mucki.agent.trunkCreated': 'Trunk „{name}“ angelegt',
    'mucki.agent.planExisting':
      'Die **{label}** ({number}) geht im Moment an {previous}. Den Trunk **{trunk}** zu `{host}` gibt es schon – ich leite die Nummer dorthin weiter.',
    'mucki.agent.already':
      'Die **{label}** geht schon an euren KI-Telefonagenten unter `{host}`. Da ist nichts mehr zu tun.',
    'mucki.agent.didUpdated': '{label} leitet jetzt zum Agenten',
    'mucki.agent.done':
      'Erledigt! Anrufe auf die **{label}** ({number}) gehen jetzt an `hotline-agent@{host}` über den Trunk **{trunk}**.\n\n- Der Agent bekommt die Nummer des Anrufers im Header `X-Zamfono-Caller` und die gewählte Nummer in `X-Zamfono-Did`.\n- Aufgezeichnet wird nichts.\n- Der Trunk hat keine ausgehende Route – normale Gespräche laufen weiter über euren Anbieter.\n\nSag einfach „Mach das rückgängig“, wenn die Hotline wieder zum Support soll.',

    'mucki.forward.read': 'Weiterleitungsregeln gelesen: {count}',
    'mucki.forward.askNumber': 'Auf welche Handynummer soll ich weiterleiten?',
    'mucki.forward.badNumber':
      'Das sah nicht nach einer Telefonnummer aus. Versuch es z. B. mit „+49 171 5550103“.',
    'mucki.forward.timeoutSet': 'Klingeldauer auf {seconds} s gesetzt',
    'mucki.forward.set': 'Bei keiner Antwort: {number}',
    'mucki.forward.done':
      'Erledigt: Dein Telefon klingelt jetzt **{seconds} Sekunden**. Nimmst du nicht ab, geht der Anruf auf dein Handy **{number}**.',
    'mucki.forward.replaced':
      'Vorher ging der Anruf in diesem Fall an {previous}.',
    'mucki.forward.link': 'Deine Weiterleitungen',

    'mucki.vacation.ask':
      'Schönen Urlaub! Ich trage dich von **{from} bis {to}** als abwesend ein. Wohin sollen deine Anrufe in der Zeit gehen?',
    'mucki.vacation.mailbox': 'Auf meine Mailbox',
    'mucki.vacation.reception': 'Empfang',
    'mucki.vacation.unclear':
      'Das Ziel habe ich nicht verstanden. Sag z. B. „Mailbox“, „Sophie Lang“ oder „Empfang“.',
    'mucki.vacation.listed': 'Bestehende Abwesenheiten: {count}',
    'mucki.vacation.overlap':
      'Du hast schon eine Abwesenheit vom {from} bis {to}, die sich damit überschneidet. Schau sie dir am besten kurz an.',
    'mucki.vacation.created': 'Abwesenheit eingetragen',
    'mucki.vacation.done':
      'Erledigt: Vom **{from} bis {to}** gehen deine Anrufe an {target}. Ab {back} klingelt wieder dein Telefon – du musst nichts zurückstellen.',
    'mucki.vacation.link': 'Deine Abwesenheiten',

    'mucki.recording.calls': 'Deine Anrufe gefunden: {count}',
    'mucki.recording.noCalls': 'Ich finde keine Anrufe von dir.',
    'mucki.recording.last':
      'Dein letztes Gespräch war am {day} um {time} mit **{peer}**.',
    'mucki.recording.listed': 'Aufzeichnungen: {count}',
    'mucki.recording.refused':
      'Aufzeichnungen kann ich dir leider nicht vorspielen – auch nicht die deiner eigenen Gespräche. Anhören dürfen sie nur Admins, das ist zum Schutz aller Gesprächspartner so geregelt.',
    'mucki.recording.offerVoicemail':
      'Soll ich dir stattdessen deine neueste Sprachnachricht vorspielen?',
    'mucki.recording.found':
      'Hier ist die Aufzeichnung vom {day}, {time}. Links hörst du dich, rechts dein Gegenüber.',
    'mucki.recording.title': 'Aufzeichnung, {time}',
    'mucki.recording.none': 'Dieses Gespräch wurde nicht aufgezeichnet.',
    'mucki.recording.link': 'Aufzeichnungen'
  },
  en: {
    'mucki.title': 'Mucki',
    'mucki.actsAs': 'acts as {name} ({role})',
    'mucki.panel': 'Mucki, your assistant',
    'mucki.newConversation': 'New conversation',
    'mucki.close': 'Close Mucki',
    'mucki.resize': 'Resize Mucki',
    'mucki.placeholder': 'Ask Mucki or say what you need …',
    'mucki.send': 'Send',
    'mucki.thinking': 'thinking …',
    'mucki.composerHint': 'Enter sends · Shift+Enter new line',
    'mucki.disclaimer':
      'Mucki works with your permissions. Every change is in the audit log.',
    'mucki.suggestions': 'Suggestions',
    'mucki.welcome.user':
      "Hi {name}! I'm **Mucki**. I look after your phone: forwarding, time off, your voicemail. What can I do for you?",
    'mucki.welcome.admin':
      "Hi {name}! I'm **Mucki**, your phone system assistant. I add people, plan closures, explain what happened to a call – and undo anything on request.",
    'mucki.welcome.owner':
      "Hi {name}! I'm **Mucki**. I handle the big things too: many new colleagues at once, updating the system or the hotline for your AI voice agent.",
    'mucki.showMe': 'Show me',
    'mucki.showMeLabel': 'Opens {label}',
    'mucki.none': 'none',
    'mucki.and': 'and',
    'mucki.ok': "Alright, I'll leave it as it is.",
    'mucki.cancelled': "Okay, cancelled – I didn't change anything.",
    'mucki.fallback':
      "I can't do that yet. I'd rather not make anything up – but here's what I'm glad to help with:",

    'mucki.chip.no': 'No',
    'mucki.chip.noThanks': 'No, thanks',
    'mucki.chip.cancel': 'Cancel',
    'mucki.chip.later': 'Later',
    'mucki.chip.play': 'Yes, play it',

    'mucki.tool.running': 'Working …',
    'mucki.tool.done': 'Done',
    'mucki.tool.awaiting': 'Waiting for your confirmation',
    'mucki.tool.cancelled': 'Cancelled, nothing changed',
    'mucki.tool.interrupted': 'Interrupted',
    'mucki.tool.refused': 'Not allowed for your role',
    'mucki.tool.missing': "This isn't available here yet",
    'mucki.tool.state.running': 'running',
    'mucki.tool.state.awaiting': 'waiting',
    'mucki.tool.state.done': 'done',
    'mucki.tool.state.refused': 'refused',
    'mucki.tool.state.error': 'error',
    'mucki.tool.state.cancelled': 'cancelled',
    'mucki.tool.input': 'Input',
    'mucki.tool.result': 'Result',
    'mucki.tool.details': 'Details',

    'mucki.confirm.label': 'Needs your confirmation',
    'mucki.confirm.cancel': 'Cancel',
    'mucki.confirm.confirmed': 'Confirmed',
    'mucki.confirm.cancelled': 'Cancelled',
    'mucki.confirm.irreversible': 'This cannot be undone.',
    'mucki.confirm.nothingYet': 'Nothing happens until you confirm.',

    'mucki.secret.label': 'Shown only once',
    'mucki.progress.done': 'created',
    'mucki.progress.failed': 'failed',
    'mucki.refusal.title': 'Not allowed',
    'mucki.error.title': "Didn't work",

    'mucki.refusal.role':
      "I can't do that for you – I always work with your permissions, and as {role} that isn't allowed. {who}",
    'mucki.refusal.askAdmin':
      'Best ask Jonas Weber or Lea Brandt, they can take care of it.',
    'mucki.refusal.askOwner': 'Only Lea Brandt as the owner can do that.',
    'mucki.refusal.notForRole':
      "I'm afraid I can't help you with that as {role}.",
    'mucki.refusal.generic':
      "I'm afraid I can't do that with your permissions. Best ask one of your administrators.",
    'mucki.error.failed': "That didn't work: {reason}",
    'mucki.error.missing':
      "I can't take care of that here yet. I didn't change anything.",
    'mucki.error.unexpected':
      'Something went wrong on my side. Feel free to try again.',

    'mucki.target.ringGroup': 'the ring group **{name}**',
    'mucki.target.mailbox': 'the voicemail of **{name}**',
    'mucki.target.ownMailbox': 'your **voicemail**',
    'mucki.target.sip': 'the SIP endpoint **{user}** via **{trunk}**',

    'mucki.prompt.onboard': 'Add a new employee',
    'mucki.prompt.batch': 'Add 8 new people from a list',
    'mucki.prompt.closure': 'Close Support on Dec 24–26, calls to voicemail',
    'mucki.prompt.undo': 'Undo that',
    'mucki.prompt.diagnose':
      'Why did the call from +49 171 5550123 at 10:15 go to voicemail?',
    'mucki.prompt.trunk': 'Is our trunk OK?',
    'mucki.prompt.update': 'Update Zamfono',
    'mucki.prompt.aiAgent': 'Send the hotline to our AI voice agent',
    'mucki.prompt.forwardMobile':
      'Forward my calls to my mobile after 20 seconds',
    'mucki.prompt.vacation': "I'm on vacation next week",
    'mucki.prompt.lastRecording': 'Play the recording of my last call',

    'mucki.op.users.list': 'Reading the user list',
    'mucki.op.users.create': 'Adding the person',
    'mucki.op.users.update': 'Updating the profile',
    'mucki.op.users.getForwarding': 'Reading your forwarding',
    'mucki.op.users.setForwarding': 'Saving the forwarding',
    'mucki.op.devices.create': 'Setting up the device',
    'mucki.op.ooo.list': 'Checking existing time off',
    'mucki.op.ooo.create': 'Adding the time off',
    'mucki.op.audit.list': 'Searching the audit log',
    'mucki.op.audit.undo': 'Undoing the change',
    'mucki.op.calls.list': 'Searching the call list',
    'mucki.op.calls.get': 'Reading the call trace',
    'mucki.op.trunks.list': 'Checking the trunks',
    'mucki.op.trunks.reregister': 'Re-registering the trunk',
    'mucki.op.trunks.create': 'Adding the trunk',
    'mucki.op.dids.list': 'Reading the numbers',
    'mucki.op.dids.update': "Changing the number's target",
    'mucki.op.system.info': 'Checking version and updates',
    'mucki.op.system.update': 'Starting the update',
    'mucki.op.backups.runs.list': 'Checking recent backups',
    'mucki.op.backups.targets.list': 'Reading the backup targets',
    'mucki.op.backups.runs.start': 'Starting a backup',
    'mucki.op.backups.runs.get': 'Waiting for the backup',
    'mucki.op.recordings.list': 'Looking for recordings',
    'mucki.op.recordings.audio': 'Fetching the recording',
    'mucki.op.voicemails.list': 'Reading the voicemail',
    'mucki.op.voicemails.audio': 'Fetching the message',

    'mucki.entry.users.create': 'adding the person',
    'mucki.entry.devices.create': 'the new device',
    'mucki.entry.ooo.create': 'the planned time off',
    'mucki.entry.ooo.update': 'the change to the time off',
    'mucki.entry.ooo.delete': 'deleting the time off',
    'mucki.entry.trunks.create': 'the new trunk',
    'mucki.entry.dids.update': "the number's new target",
    'mucki.entry.users.setForwarding': 'the forwarding rules',
    'mucki.entry.users.update': 'the profile change',
    'mucki.entry.other': 'the last change',

    'mucki.onboard.ask':
      'Sure! What is the new person called, which e-mail address and which extension do they get?',
    'mucki.onboard.sample':
      'Tom Becker, tom.becker@brandt-partner.de, extension 105, with the app',
    'mucki.onboard.incomplete':
      'I need at least the name and an e-mail address or extension. Try e.g. "Tom Becker, tom.becker@brandt-partner.de, extension 105".',
    'mucki.onboard.plan':
      "Got it: I'm adding **{name}** as an employee – e-mail {email}, extension **{extension}**.",
    'mucki.onboard.created': '{name} added, extension {extension}',
    'mucki.onboard.linkLabel': 'Set-password link',
    'mucki.onboard.linkNote':
      'Also sent by e-mail to {email}. Valid for 7 days.',
    'mucki.onboard.askApp':
      'Should {name} get the Ringotel app on their phone right away?',
    'mucki.onboard.appYes': 'Yes, with the app',
    'mucki.onboard.deviceCreated': 'Device "{label}" set up',
    'mucki.onboard.deviceOk':
      'The app is set up: Ringotel sends an activation e-mail with a QR code, nobody has to type in credentials.',
    'mucki.onboard.deviceWarning':
      'The device was created, but Ringotel reports: {warning}',
    'mucki.onboard.done':
      'Done! **{name}** can be reached on extension **{extension}**.{link}',
    'mucki.onboard.doneLink': ' You can also pass on the link above directly.',

    'mucki.closure.noGroup': "I couldn't find a matching ring group.",
    'mucki.closure.listed': 'Time-off rules for {name}: {count}',
    'mucki.closure.overlap':
      '**{name}** already has time off from {from} to {to} that overlaps. Active periods must not overlap – best take a quick look.',
    'mucki.closure.created': 'Closure for {name} added',
    'mucki.closure.done':
      "Done: the ring group **{name}** is closed from **{from} to {to}**. Calls go to {name}'s voicemail; from {reopen} everything runs as usual.{mailboxNote}",
    'mucki.closure.mailboxOff': " Note: {name}'s voicemail is switched off.",
    'mucki.closure.link': "{name}'s schedule",

    'mucki.undo.listed': 'Changes of mine found: {count}',
    'mucki.undo.nothing':
      "I haven't changed anything in this conversation that I could undo.",
    'mucki.undo.found':
      "My last change was {what} ({when}). I'll take it back.",
    'mucki.undo.reverted': 'Change reverted',
    'mucki.undo.done':
      'Done – {what} is undone. The audit log now has an undo entry for it.',
    'mucki.undo.more':
      'I changed more before that ({count}). Just say "Undo that" again.',
    'mucki.undo.later':
      'Not yet: the same entry was changed afterwards. Undo this first:\n{refs}',
    'mucki.undo.failed': "That couldn't be undone. {reason}",
    'mucki.undo.link': 'Audit log',

    'mucki.diagnose.listed': 'Inbound calls found: {count}',
    'mucki.diagnose.read': 'Read the trace with {lines} steps',
    'mucki.diagnose.notFound':
      "I can't find a matching call from {caller} in the last seven days.",
    'mucki.diagnose.summary':
      "I found the call ({day}, {time}). Here's how it went:",
    'mucki.diagnose.entry':
      'At {time} **{caller}** called the **{did}** ({number}).',
    'mucki.diagnose.company': 'the company',
    'mucki.diagnose.group': 'the ring group {name}',
    'mucki.diagnose.open':
      'No time off in effect; **open** by the opening hours: {who}.',
    'mucki.diagnose.closed': '**Closed** by the opening hours: {who}.',
    'mucki.diagnose.ooo': '**Time off** was in effect for {who}.',
    'mucki.diagnose.greeting': 'First the greeting played.',
    'mucki.diagnose.ringGroup':
      'Then the ring group **{name}** rang ({strategy}).',
    'mucki.diagnose.strategy.simultaneous': 'everyone at once',
    'mucki.diagnose.strategy.sequential': 'one after another',
    'mucki.diagnose.strategy.random': 'in random order',
    'mucki.diagnose.members': 'The members:',
    'mucki.diagnose.noAnswer': "{who}: rang {seconds} s, didn't pick up",
    'mucki.diagnose.noDevice': '{who}: no phone registered',
    'mucki.diagnose.rung': '{who}: rang',
    'mucki.diagnose.skippedBusy': '{who}: skipped – was on a call',
    'mucki.diagnose.skippedDnd': '{who}: skipped – "Do not disturb" was on',
    'mucki.diagnose.answered': '{who} picked up.',
    'mucki.diagnose.ringTotal':
      'After **{seconds} seconds** in total without an answer,',
    'mucki.diagnose.forward':
      'the "{condition}" rule applied and forwarded to {target}.',
    'mucki.diagnose.condition.unanswered': 'unanswered',
    'mucki.diagnose.condition.unavailable': 'nobody available',
    'mucki.diagnose.condition.noAnswer': 'no answer',
    'mucki.diagnose.condition.busy': 'busy',
    'mucki.diagnose.mailbox':
      'The call ended up in the voicemail of **{name}**.',
    'mucki.diagnose.endedCaller': 'The caller hung up after {duration}.',
    'mucki.diagnose.ended': 'The call ended after {duration}.',
    'mucki.diagnose.verdict':
      '**In short:** the system did everything right – nobody in {name} was free to pick up.',
    'mucki.diagnose.qosGood':
      'The connection was fine (jitter {jitter} ms, loss {loss} %, round trip {rtt} ms).',
    'mucki.diagnose.qosBad':
      'The connection was shaky (jitter {jitter} ms, loss {loss} %, round trip {rtt} ms) – that is audible.',
    'mucki.diagnose.qosNone':
      'There are no quality measurements for this call.',
    'mucki.diagnose.link': 'Call in the history',
    'mucki.diagnose.offerPlay':
      'The caller left a message. Shall I play it for you?',

    'mucki.voicemail.listed': 'Voicemails: {count}',
    'mucki.voicemail.none': "I can't find a voicemail for that.",
    'mucki.voicemail.title': 'Message from {caller}, {time}',
    'mucki.voicemail.latest':
      'Your newest message: from **{caller}**, {day} at {time}, {duration} long.',
    'mucki.voicemail.link': 'Voicemail',
    'mucki.audio.link': 'Download link created (valid for 5 minutes)',

    'mucki.trunk.listed': 'Trunks checked: {count}',
    'mucki.trunk.status.registered':
      '**{name}**: registered and ready since {time} ({since}).',
    'mucki.trunk.status.unreachable':
      "**{name}** is **unreachable** right now (since {time}). Outbound calls over it don't work at the moment.",
    'mucki.trunk.status.unmonitored':
      '**{name}**: not monitored – calls go out anyway.',
    'mucki.trunk.status.unknown': '**{name}**: status not known yet.',
    'mucki.trunk.allGood': 'All good, your line is up:',
    'mucki.trunk.ipTrunk':
      "{name} doesn't register; the provider recognises it by IP address. Re-registering doesn't apply – best ask the provider.",
    'mucki.trunk.offer':
      'Re-registering with the provider usually helps. Shall I do that?',
    'mucki.trunk.reregister': 'Yes, re-register',
    'mucki.trunk.reregistered': 'Re-registration of {name} triggered',
    'mucki.trunk.waiting': 'Waiting for the registration …',
    'mucki.trunk.checked': 'Registered again',
    'mucki.trunk.back':
      'Done: **{name}** has been registered again since {time}. Outside calls work again.',
    'mucki.trunk.stillDown':
      "**{name}** isn't registered again yet. I'd wait a few minutes and then ask the provider.",

    'mucki.batch.askPaste':
      'Sure! Just paste the list – one person per line: name; e-mail; extension.',
    'mucki.batch.sampleChip': 'Paste a sample list (8 rows)',
    'mucki.batch.noRows':
      'I couldn\'t recognise any rows of the form "name; e-mail; extension".',
    'mucki.batch.confirm':
      'I recognised **{count} people**:\n\n{rows}\n\nEveryone gets the role employee and a set-password link by e-mail. Shall I go ahead?',
    'mucki.batch.go': 'Yes, add them all',
    'mucki.batch.progress': '{done} / {total} created',
    'mucki.batch.extTaken': 'extension {extension} already belongs to {owner}',
    'mucki.batch.parking': 'a parking slot',
    'mucki.batch.summary': '**{done} of {total}** created.',
    'mucki.batch.failures': 'Not created:',
    'mucki.batch.links': 'Everyone new got their set-password link by e-mail.',
    'mucki.batch.link': 'User list',
    'mucki.batch.offerFree':
      'Shall I add **{name}** with the free extension **{extension}** instead?',
    'mucki.batch.useFree': 'Yes, with {extension}',
    'mucki.batch.retryDone':
      'Done: **{name}** has extension **{extension}**. That makes {done} of {total}.',

    'mucki.update.info': 'Running version {current}',
    'mucki.update.running':
      "An update is already running. I'd rather wait until it's finished.",
    'mucki.update.current': "You're up to date: version **{current}**.",
    'mucki.update.breaking':
      'Version **{latest}** contains major changes. It is installed directly on the server, not through me – best by whoever looks after your server, after reading the notes on the new version.',
    'mucki.update.available':
      'There is an update: **{current} → {latest}** (published {published}).',
    'mucki.update.ownerOnly':
      'Only an owner may start the update – best ask Lea Brandt. I can tell you what it contains, though.',
    'mucki.update.runs': 'Backups found: {count}',
    'mucki.update.needBackup':
      "An update needs a successful backup from the last hour – the last one was on {lastDay} at {last}. I'm starting one.",
    'mucki.update.targets': 'Backup targets: {count}',
    'mucki.update.noTarget':
      'No backup target is enabled. Please set one up first.',
    'mucki.update.backupStarted': 'Backup to "{target}" started',
    'mucki.update.backupWaiting': 'Backup to "{target}" running …',
    'mucki.update.backupOk': 'Backup finished ({size} new)',
    'mucki.update.backupFailedShort': 'Backup failed',
    'mucki.update.backupFailed':
      "The backup failed: {error}. I won't start an update without a backup.",
    'mucki.update.timeout': "it didn't finish in time",
    'mucki.update.backupDone':
      'The backup to **{target}** is done (snapshot `{snapshot}`). Now the update – please confirm.',
    'mucki.update.backupRecent':
      'There is a fresh backup from {time}. Now the update – please confirm.',
    'mucki.update.started': 'Update to {latest} started',
    'mucki.update.maintenance':
      'The system is now in **maintenance mode**. Ongoing calls drop briefly; in a minute or two everything is back.',
    'mucki.update.waiting': 'Maintenance – waiting for the restart …',
    'mucki.update.slow':
      'The update is taking longer than usual. See System & updates for its state.',
    'mucki.update.done':
      'Done! Zamfono now runs version **{latest}** (restarted at {at}).',

    'mucki.agent.askHost':
      'Sure! At which SIP address can your AI voice agent be reached?',
    'mucki.agent.noHost':
      "I couldn't read a SIP address from that. A host name like `sip.voiceagent.example` will do.",
    'mucki.agent.dids': 'Numbers read: {count}',
    'mucki.agent.noHotline': "I can't find a hotline number.",
    'mucki.agent.plan':
      "The **{label}** ({number}) currently goes to {previous}. I'll add a trunk **{trunk}** to `{host}` and forward the number there.",
    'mucki.agent.trunkCreated': 'Trunk "{name}" added',
    'mucki.agent.planExisting':
      "The **{label}** ({number}) currently goes to {previous}. The trunk **{trunk}** to `{host}` already exists – I'll forward the number there.",
    'mucki.agent.already':
      'The **{label}** already goes to your AI voice agent at `{host}`. Nothing left to do.',
    'mucki.agent.didUpdated': '{label} now goes to the agent',
    'mucki.agent.done':
      'Done! Calls to the **{label}** ({number}) now go to `hotline-agent@{host}` over the trunk **{trunk}**.\n\n- The agent gets the caller\'s number in the `X-Zamfono-Caller` header and the dialled number in `X-Zamfono-Did`.\n- Nothing is recorded.\n- The trunk has no outbound route – regular calls keep using your provider.\n\nJust say "Undo that" if the hotline should go back to Support.',

    'mucki.forward.read': 'Forwarding rules read: {count}',
    'mucki.forward.askNumber': 'Which mobile number should I forward to?',
    'mucki.forward.badNumber':
      'That didn\'t look like a phone number. Try e.g. "+49 171 5550103".',
    'mucki.forward.timeoutSet': 'Ring time set to {seconds} s',
    'mucki.forward.set': 'On no answer: {number}',
    'mucki.forward.done':
      "Done: your phone now rings for **{seconds} seconds**. If you don't pick up, the call goes to your mobile **{number}**.",
    'mucki.forward.replaced': 'Before, such calls went to {previous}.',
    'mucki.forward.link': 'Your forwarding',

    'mucki.vacation.ask':
      "Have a great vacation! I'll mark you as away from **{from} to {to}**. Where should your calls go meanwhile?",
    'mucki.vacation.mailbox': 'To my voicemail',
    'mucki.vacation.reception': 'Reception',
    'mucki.vacation.unclear':
      'I didn\'t get the target. Say e.g. "voicemail", "Sophie Lang" or "reception".',
    'mucki.vacation.listed': 'Existing time-off rules: {count}',
    'mucki.vacation.overlap':
      'You already have time off from {from} to {to} that overlaps. Best take a quick look.',
    'mucki.vacation.created': 'Time off added',
    'mucki.vacation.done':
      'Done: from **{from} to {to}** your calls go to {target}. From {back} your phone rings again – nothing to switch back.',
    'mucki.vacation.link': 'Your time off',

    'mucki.recording.calls': 'Calls of yours found: {count}',
    'mucki.recording.noCalls': "I can't find any calls of yours.",
    'mucki.recording.last':
      'Your last call was on {day} at {time} with **{peer}**.',
    'mucki.recording.listed': 'Recordings: {count}',
    'mucki.recording.refused':
      "I'm afraid I can't play recordings for you – not even of your own calls. Only admins may listen to them; that protects everyone on the call.",
    'mucki.recording.offerVoicemail':
      'Shall I play your newest voicemail instead?',
    'mucki.recording.found':
      'Here is the recording from {day}, {time}. Left is you, right the other side.',
    'mucki.recording.title': 'Recording, {time}',
    'mucki.recording.none': "This call wasn't recorded.",
    'mucki.recording.link': 'Recordings'
  }
} satisfies Messages;
