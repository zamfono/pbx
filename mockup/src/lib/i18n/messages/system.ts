/**
 * System area: settings, mail templates, AI & API, backups, audit log, system & updates, Ringotel
 * setup and SIP protection.
 */
import type { Messages } from '../index.svelte';

export default {
  de: {
    /* ---------- settings ---------- */
    'settings.subtitle':
      'Grundeinstellungen der Telefonanlage. Jeder Bereich wird einzeln gespeichert.',
    'settings.tab.general': 'Allgemein',
    'settings.tab.calls': 'Anrufe & Mailbox',
    'settings.tab.featureCodes': 'Funktionscodes',
    'settings.tab.mail': 'E-Mail',
    'settings.tab.signIn': 'Anmeldung & SSO',
    'settings.tab.retention': 'Aufbewahrung',
    'settings.tab.updates': 'Updates',
    'settings.tab.ringotel': 'Ringotel',
    'settings.saved': 'Einstellungen gespeichert',
    'settings.unsaved': 'Ungespeicherte Änderungen',
    'settings.discard': 'Verwerfen',
    'settings.card.company': 'Firma',
    'settings.card.companyBody':
      'Name, Hauptnummer und die Sprache der Ansagen und E-Mails.',
    'settings.card.region': 'Region',
    'settings.card.regionBody':
      'Land und Zeitzone für Rufnummern und alle Uhrzeiten.',
    'settings.card.calls': 'Anrufe',
    'settings.card.callsBody':
      'Voreinstellungen für alle; einzelne Personen können sie überschreiben.',
    'settings.card.limits': 'Mailbox & Parken',
    'settings.card.limitsBody':
      'Wie lang Nachrichten sein dürfen und geparkte Anrufe warten.',
    'settings.card.fallback': 'Nicht zugeordnete Nummern',
    'settings.card.fallbackBody':
      'Wohin Anrufe auf Nummern gehen, die keinem Ziel zugeordnet sind.',
    'settings.card.featureCodes': 'Funktionscodes',
    'settings.card.featureCodesBody':
      'Codes, die man am Telefon wählt. Jeder beginnt mit * oder #, keiner darf der Anfang eines anderen sein.',
    'settings.card.emergency': 'Notrufnummern',
    'settings.card.emergencyBody':
      'Werden immer als Notruf nach außen gewählt und sind nie interne Durchwahlen.',
    'settings.card.mail': 'Mailserver',
    'settings.card.mailBody':
      'Über diesen Server verschickt die Anlage Sprachnachrichten, Einladungen und Hinweise.',
    'settings.card.mfa': 'Zwei-Faktor-Anmeldung',
    'settings.card.mfaBody':
      'Inhaber:innen und Admins melden sich immer mit zweitem Faktor an.',
    'settings.card.sso': 'Single Sign-on',
    'settings.card.ssoBody':
      'Anmeldung mit dem Firmenkonto bei Microsoft, Google oder einem OIDC-Anbieter.',
    'settings.card.retention': 'Aufbewahrung',
    'settings.card.retentionBody':
      'Wie lange Daten gespeichert bleiben. Leer lassen heißt: unbegrenzt.',
    'settings.card.updates': 'Updates',
    'settings.card.updatesBody':
      'Wie neue Versionen der Telefonanlage eingespielt werden.',
    'settings.card.backupSchedule': 'Backup-Zeitplan',
    'settings.card.backupScheduleBody':
      'Wann das automatische Backup auf alle aktiven Ziele läuft.',
    'settings.card.ringotel': 'Ringotel-App',
    'settings.card.ringotelBody':
      'Die Smartphone- und Desktop-App für Ihr Team.',
    'settings.language.de': 'Deutsch',
    'settings.language.en': 'Englisch',
    'settings.language.es': 'Spanisch',
    'settings.language.fr': 'Französisch',
    'settings.language.it': 'Italienisch',
    'settings.language.ru': 'Russisch',
    'settings.timezone.stack': 'Zeitzone des Servers',
    'settings.extLength.value': '{digits} Ziffern',
    'settings.clir.switch':
      'Eigene Nummer bei ausgehenden Anrufen unterdrücken',
    'settings.rejectAnonymous.switch':
      'Anrufe mit unterdrückter Nummer abweisen',
    'settings.moh.builtin': 'Eingebaute Wartemusik',
    'settings.codecs.add': 'Codec hinzufügen …',
    'settings.codec.opus': 'Opus (HD, passt sich der Leitung an)',
    'settings.codec.g722': 'G.722 (HD)',
    'settings.codec.amrwb': 'AMR-WB (HD Mobilfunk)',
    'settings.codec.amr': 'AMR (Mobilfunk)',
    'settings.codec.alaw': 'G.711 A-law (Europa)',
    'settings.codec.ulaw': 'G.711 µ-law (Nordamerika)',
    'settings.callLogLevel.none': 'Aus',
    'settings.callLogLevel.events': 'Ablauf',
    'settings.callLogLevel.qos': '+ Qualität',
    'settings.callLogLevel.sip': '+ SIP',
    'settings.fallback.none': 'Anruf abweisen',
    'settings.fc.pickup': 'Heranholen',
    'settings.fc.pickup.help':
      'Plus Durchwahl: nimmt einen Anruf an, der bei jemand anderem klingelt.',
    'settings.fc.dndOn': 'Nicht stören an',
    'settings.fc.dndOn.help': 'Schaltet „Nicht stören“ für Sie ein.',
    'settings.fc.dndOff': 'Nicht stören aus',
    'settings.fc.dndOff.help': 'Schaltet „Nicht stören“ wieder aus.',
    'settings.fc.mailbox': 'Mailbox abhören',
    'settings.fc.mailbox.help':
      'Plus Durchwahl: hört eine Mailbox ab (mit PIN).',
    'settings.fc.ownVoicemail': 'Eigene Mailbox',
    'settings.fc.ownVoicemail.help': 'Öffnet direkt die eigene Mailbox.',
    'settings.fc.deposit': 'Auf Mailbox sprechen',
    'settings.fc.deposit.help':
      'Plus Durchwahl: spricht direkt auf die Mailbox, ohne dass es klingelt.',
    'settings.fc.addParty': 'Teilnehmer dazuholen',
    'settings.fc.addParty.help':
      'Plus Nummer, während eines Gesprächs: holt eine dritte Person dazu.',
    'settings.fc.clirOn': 'Nummer unterdrücken',
    'settings.fc.clirOn.help':
      'Vor der Nummer: dieser Anruf geht ohne Ihre Nummer raus.',
    'settings.fc.clirOff': 'Nummer anzeigen',
    'settings.fc.clirOff.help':
      'Vor der Nummer: dieser Anruf zeigt Ihre Nummer an.',
    'settings.fc.park': 'Parken',
    'settings.fc.park.help':
      'Während eines Gesprächs: parkt den Anruf auf einem freien Parkplatz.',
    'settings.emergency.digits': 'Nur Ziffern.',
    'settings.mail.noRelay':
      'Kein Mailserver – es werden keine E-Mails verschickt',
    'settings.smtpSecurity.tls': 'TLS (verschlüsselt ab Start)',
    'settings.smtpSecurity.starttls': 'STARTTLS',
    'settings.smtpCheck.none': 'nur bei Start und Änderungen',
    'settings.mail.statusOk': 'Mailserver erreichbar',
    'settings.mail.statusFailing': 'Mailserver meldet einen Fehler: {class}',
    'settings.mail.statusNone': 'Kein Mailserver eingerichtet',
    'settings.mail.statusNoneBody':
      'Ohne Server und Absender verschickt die Anlage keine E-Mails.',
    'settings.mail.checkedAt': 'Zuletzt geprüft {at}',
    'settings.mail.templatesHint':
      'Den Text der E-Mails passen Sie in den E-Mail-Vorlagen an.',
    'settings.mail.fromPlaceholder': 'Telefonanlage <telefon@example.com>',
    'settings.mfa.switch': 'Zweiten Faktor für alle verlangen',
    'settings.mfa.on': 'Für alle verlangt',
    'settings.mfa.off': 'Nur für Inhaber:innen und Admins',
    'settings.sso.provider.none': 'Aus',
    'settings.sso.provider.microsoft': 'Microsoft',
    'settings.sso.provider.google': 'Google',
    'settings.sso.provider.oidc': 'OIDC',
    'settings.sso.labelPlaceholder': 'Mit Firmenkonto anmelden',
    'settings.sso.labelDefault': 'Standardtext des Anbieters',
    'settings.sso.anyDomain': 'Jede Domain',
    'settings.sso.resetWarning':
      'Speichern trennt die SSO-Verknüpfung von {count} Personen. Sie verknüpfen ihr Konto bei der nächsten Anmeldung neu.',
    'settings.retention.forever': 'unbegrenzt',
    'settings.retention.days': '{days} Tage',
    'settings.autoUpdate.switch': 'Neue Versionen automatisch einspielen',
    'settings.autoUpdate.on': 'Automatisch',
    'settings.autoUpdate.off': 'Nur von Hand',
    'settings.tlsReloadHour.none': 'Nicht festgelegt',
    'settings.ringotel.status': 'Verbindung',
    'settings.ringotel.connected': 'Verbunden',
    'settings.ringotel.notConnected': 'Nicht eingerichtet',
    'settings.ringotel.orgId': 'Organisations-ID',
    'settings.ringotel.branchId': 'Verbindungs-ID',
    'settings.ringotel.maxRegsValue': '{count} Geräte pro Person',
    'settings.ringotel.pushPending': 'Änderung wird an Ringotel übertragen …',

    'field.settings.companyName': 'Firmenname',
    'field.settings.companyName.help':
      'Erscheint in E-Mails und auf der Anmeldeseite.',
    'field.settings.mainDidId': 'Hauptnummer',
    'field.settings.mainDidId.help':
      'Wird bei ausgehenden Anrufen angezeigt, wenn weder Route noch Person eine eigene Nummer festlegen.',
    'field.settings.country': 'Land',
    'field.settings.country.help':
      'Seine Vorwahl macht aus 089 … die internationale Form +4989 ….',
    'field.settings.timezone': 'Zeitzone',
    'field.settings.timezone.help':
      'Gilt für Öffnungszeiten, Abwesenheiten und alle angezeigten Uhrzeiten.',
    'field.settings.language': 'Sprache',
    'field.settings.language.help':
      'Sprache der Ansagen für Anrufende, der E-Mails und der Anmeldeseiten.',
    'field.settings.extLength': 'Länge der Durchwahlen',
    'field.settings.extLength.help': 'Bei der Einrichtung festgelegt.',
    'field.settings.smtpHost': 'Server',
    'field.settings.smtpHost.help': 'Leer: es werden keine E-Mails verschickt.',
    'field.settings.smtpPort': 'Port',
    'field.settings.smtpPort.help': 'Meist 465 (TLS) oder 587 (STARTTLS).',
    'field.settings.smtpSecurity': 'Verschlüsselung',
    'field.settings.smtpSecurity.help':
      'TLS verschlüsselt sofort; STARTTLS schaltet eine einfache Verbindung auf Verschlüsselung um.',
    'field.settings.smtpUser': 'Benutzername',
    'field.settings.smtpPassword': 'Passwort',
    'field.settings.smtpPassword.help':
      'Wird nie wieder angezeigt, nur ob eines gesetzt ist.',
    'field.settings.mailFrom': 'Absender',
    'field.settings.mailFrom.help':
      'Der Server muss für diese Domain senden dürfen. Leer: keine E-Mails.',
    'field.settings.smtpCheckIntervalS': 'Prüfintervall',
    'field.settings.smtpCheckIntervalS.help':
      'Wie oft die Anlage den Mailserver im Hintergrund prüft (60 bis 86400 Sekunden).',
    'field.settings.emergencyNumbers': 'Notrufnummern',
    'field.settings.emergencyNumbers.help':
      'Darf keine bestehende Durchwahl sein.',
    'field.settings.featureCodes': 'Funktionscodes',
    'field.settings.fallbackTarget': 'Ziel',
    'field.settings.fallbackTarget.help':
      'Für Nummern in einem Nummernblock ohne eigenes Ziel und für alle unbekannten Nummern. Ohne Ziel wird der Anruf abgewiesen.',
    'field.settings.codecs': 'Codecs',
    'field.settings.codecs.help':
      'Die Reihenfolge, in der Geräten und Trunks ohne eigene Liste Codecs angeboten werden; der erste wird bevorzugt.',
    'field.settings.clir': 'Rufnummer unterdrücken',
    'field.settings.clir.help':
      'Voreinstellung; Trunk, Person und der Funktionscode #31# überschreiben sie.',
    'field.settings.rejectAnonymous': 'Anonyme Anrufe',
    'field.settings.rejectAnonymous.help':
      'Voreinstellung; jede Person kann sie für sich ändern.',
    'field.settings.holdMohAudioId': 'Wartemusik',
    'field.settings.holdMohAudioId.help':
      'Was Anrufende in der Warteschleife hören.',
    'field.settings.voicemailMaxS': 'Länge einer Nachricht',
    'field.settings.voicemailMaxS.help':
      'Höchstens so viele Sekunden; Standard 180.',
    'field.settings.parkingTimeoutS': 'Parkdauer',
    'field.settings.parkingTimeoutS.help':
      'Danach klingelt ein geparkter Anruf wieder bei der Person, die ihn geparkt hat; Standard 300.',
    'field.settings.callLogLevel': 'Diagnosestufe',
    'field.settings.callLogLevel.help':
      'Was zu jedem Anruf protokolliert wird: Ablauf (Standard), dazu Sprachqualität, dazu SIP-Mitschnitt.',
    'field.settings.recordingRetentionDays': 'Aufzeichnungen & Anrufverlauf',
    'field.settings.recordingRetentionDays.help':
      'Gilt auch für Anrufprotokolle, Sprachqualität, Präsenzverlauf und Backup-Läufe. Standard 90 Tage.',
    'field.settings.softDeleteRetentionDays': 'Gelöschte Einträge',
    'field.settings.softDeleteRetentionDays.help':
      'So lange lässt sich ein Löschen rückgängig machen. Höchstens so lange, wie das Änderungsprotokoll aufbewahrt wird.',
    'field.settings.auditRetentionDays': 'Änderungsprotokoll',
    'field.settings.auditRetentionDays.help': 'Mindestens 30 Tage.',
    'field.settings.sipBanFailures': 'Fehlversuche bis zur Sperre',
    'field.settings.sipBanFailures.help':
      'So viele fehlgeschlagene SIP-Anmeldungen einer Adresse im Zeitfenster sperren sie; Standard 10.',
    'field.settings.sipBanWindowS': 'Zeitfenster',
    'field.settings.sipBanWindowS.help':
      'Über diesen Zeitraum werden Fehlversuche gezählt; Standard 1 Stunde.',
    'field.settings.sipBanSuccessExemptS':
      'Schutz nach erfolgreicher Anmeldung',
    'field.settings.sipBanSuccessExemptS.help':
      'So lange nach einer erfolgreichen Anmeldung wird eine Adresse nie gesperrt; 0 schützt nicht. Standard 1 Tag.',
    'field.settings.sipBanLookbackS': 'Rückfallzeitraum',
    'field.settings.sipBanLookbackS.help':
      'Wird eine Adresse innerhalb dieser Zeit nach dem Ende einer Sperre wieder gesperrt, gilt die nächste Stufe; Standard 30 Tage.',
    'field.settings.sipBanSteps': 'Sperrstufen',
    'field.settings.sipBanSteps.help':
      'Dauer der ersten, zweiten, … Sperre einer Adresse, jede länger als die vorige. Gilt nur für neue Sperren.',
    'field.settings.backupCron': 'Zeitplan',
    'field.settings.backupCron.help':
      'Cron-Ausdruck: Minute, Stunde, Tag, Monat, Wochentag. Standard 0 3 * * * (täglich 3 Uhr).',
    'field.settings.tlsReloadHour': 'Stunde für Zertifikatswechsel',
    'field.settings.tlsReloadHour.help':
      'Wann ein erneuertes Zertifikat aktiviert wird, falls die Öffnungszeiten keine geschlossene Zeit bieten.',
    'field.settings.autoUpdate': 'Automatische Updates',
    'field.settings.autoUpdate.help':
      'Spielt neue, kompatible Versionen nach einem Backup ein, wenn gerade niemand telefoniert.',
    'field.settings.mfaRequiredForAll': 'Zweiter Faktor für alle',
    'field.settings.mfaRequiredForAll.help':
      'Dann brauchen auch Mitarbeiter:innen einen Passkey oder eine Authenticator-App.',
    'field.settings.ssoProvider': 'Anbieter',
    'field.settings.ssoLabel': 'Beschriftung des Buttons',
    'field.settings.ssoLabel.help': 'Pflicht bei OIDC.',
    'field.settings.ssoIssuer': 'Issuer-URL',
    'field.settings.ssoIssuer.help':
      'Pflicht bei OIDC; bei Microsoft und Google vorgegeben.',
    'field.settings.ssoClientId': 'Client-ID',
    'field.settings.ssoClientId.help':
      'Aus der App-Registrierung beim Anbieter.',
    'field.settings.ssoTenantId': 'Mandanten-ID (Entra)',
    'field.settings.ssoTenantId.help':
      'Ihre Microsoft-Entra-Mandanten-ID, damit nur Konten Ihrer Firma angenommen werden.',
    'field.settings.ssoAllowedDomain': 'Erlaubte Domain',
    'field.settings.ssoAllowedDomain.help':
      'Nur Konten mit dieser E-Mail-Domain dürfen sich anmelden.',
    'field.settings.ssoClientSecret': 'Client-Secret',
    'field.settings.ssoClientSecret.help':
      'Wird nie wieder angezeigt, nur ob eines gesetzt ist.',
    'field.settings.ringotelMaxRegs': 'Geräte pro Person',
    'field.settings.ringotelMaxRegs.help':
      'Auf wie vielen Geräten eine Person die App gleichzeitig nutzen darf; die Einrichtung übernimmt den Wert des Pakets.',
    'field.settings.ringotelApiToken': 'Ringotel-API-Token',
    'field.settings.ringotelApiToken.help':
      'Aus der Ringotel-Shell; wird nie wieder angezeigt.',

    'errors.settingsReadOnly': '{field} lässt sich nicht ändern.',
    'errors.settingsMainDid':
      'Die Hauptnummer muss eine aktive Rufnummer sein.',
    'errors.settingsCountry': 'Bitte ein Land mit Ländervorwahl wählen.',
    'errors.settingsTimezone': 'Unbekannte Zeitzone.',
    'errors.settingsEmergencyDigits':
      'Bitte mindestens eine Notrufnummer angeben, nur Ziffern.',
    'errors.settingsEmergencyExtension':
      'Schon eine Durchwahl, kann keine Notrufnummer sein: {list}',
    'errors.settingsCodecs': 'Bitte mindestens einen Codec wählen.',
    'errors.settingsMohAudio':
      'Bitte eine Wartemusik aus der Audiothek wählen.',
    'errors.settingsRetentionWindow':
      'Gelöschte Einträge ({softDelete} Tage) dürfen nicht länger aufbewahrt werden als das Änderungsprotokoll ({audit} Tage) – sonst ließe sich das Löschen nicht mehr rückgängig machen.',
    'errors.settingsCron': 'Kein gültiger Cron-Ausdruck.',
    'errors.settingsSsoClientId':
      'Mit einem SSO-Anbieter ist die Client-ID Pflicht.',
    'errors.settingsSsoTenantId': 'Für Microsoft ist die Mandanten-ID Pflicht.',
    'errors.settingsSsoOidc':
      'Für OIDC sind Issuer-URL und Beschriftung Pflicht.',
    'errors.settingsFallbackExternal':
      'Bitte eine Rufnummer im internationalen Format.',
    'errors.featureCodeKeys': 'Bitte alle zehn Funktionscodes ausfüllen.',
    'errors.featureCodeStart': 'Muss mit * oder # beginnen.',
    'errors.featureCodeSame':
      '„{code}“ ist schon für eine andere Funktion vergeben.',
    'errors.featureCodePrefix':
      '„{code}“ ist der Anfang von „{other}“ – das Telefon könnte sie nicht unterscheiden.',
    'errors.sipBanSteps': 'Ungültige Sperrstufen.',
    'errors.sipBanStepsRange':
      'Jede Sperre dauert mindestens 1 Minute und höchstens 100 Jahre.',
    'errors.sipBanStepsIncreasing':
      'Jede Stufe muss länger sein als die vorige.',
    'errors.sipBanStepsPermanentLast': 'Dauerhaft geht nur als letzte Stufe.',

    /* ---------- mail templates ---------- */
    'mailTemplates.subtitle':
      'Die E-Mails der Anlage in allen Sprachen. Ihre Fassung ersetzt die mitgelieferte.',
    'mailTemplates.kinds': 'E-Mail-Arten',
    'mailTemplates.kind.voicemail': 'Neue Sprachnachricht',
    'mailTemplates.kind.voicemail.help':
      'An die Mailbox-Inhaber:innen, mit der Aufnahme im Anhang.',
    'mailTemplates.kind.missedCall': 'Verpasster Anruf',
    'mailTemplates.kind.missedCall.help':
      'An Personen, die über verpasste Anrufe informiert werden möchten.',
    'mailTemplates.kind.setup': 'Einladung',
    'mailTemplates.kind.setup.help':
      'Neues Konto: Link zum Festlegen des Passworts.',
    'mailTemplates.kind.reset': 'Passwort zurücksetzen',
    'mailTemplates.kind.reset.help': 'Link zum Zurücksetzen des Passworts.',
    'mailTemplates.kind.updateFailed': 'Update fehlgeschlagen',
    'mailTemplates.kind.updateFailed.help':
      'An Inhaber:innen, wenn ein automatisches Update scheitert.',
    'mailTemplates.kind.breakingUpdate': 'Größeres Update verfügbar',
    'mailTemplates.kind.breakingUpdate.help':
      'An Inhaber:innen, wenn eine Version von Hand eingespielt werden muss.',
    'mailTemplates.kind.mfaChanged': 'Anmeldesicherheit geändert',
    'mailTemplates.kind.mfaChanged.help':
      'An die Person, wenn ihr zweiter Faktor geändert wurde.',
    'mailTemplates.customised': 'Eigene Fassung: {languages}',
    'mailTemplates.override': 'Eigene Fassung',
    'mailTemplates.shipped': 'Mitgeliefert',
    'mailTemplates.tenantLanguage': 'Sprache der Anlage',
    'mailTemplates.updatedAt': 'geändert {at}',
    'mailTemplates.language': 'Sprache',
    'mailTemplates.htmlSwitch': 'Zusätzlich eine HTML-Fassung senden',
    'mailTemplates.placeholders': 'Platzhalter – zum Einfügen klicken',
    'mailTemplates.insert': 'An der Cursorposition einfügen',
    'mailTemplates.required': 'Pflicht',
    'mailTemplates.syntaxHint':
      'Erlaubt: {{name}}, {{date name}} für Zeitpunkte und Bedingungen mit {{#if name}} … {{else}} … {{/if}}.',
    'mailTemplates.unknown': 'Für diese E-Mail nicht verfügbar: {names}',
    'mailTemplates.missing': 'Muss vorkommen: {names}',
    'mailTemplates.revert': 'Auf mitgelieferte Fassung zurücksetzen',
    'mailTemplates.test': 'Test an mich senden',
    'mailTemplates.testSaveFirst':
      'Erst speichern – getestet wird die gespeicherte Fassung.',
    'mailTemplates.test.sent': 'Test-E-Mail ({language}) an {email} verschickt',
    'mailTemplates.test.skipped':
      'Nicht verschickt: kein Mailserver eingerichtet oder keine E-Mail-Adresse',
    'mailTemplates.test.failed':
      'Der Mailserver hat die Test-E-Mail nicht angenommen',
    'mailTemplates.otherLanguage':
      'Verschickt wird in der Sprache der Anlage ({language}); diese Fassung gilt, sobald die Sprache umgestellt wird.',
    'mailTemplates.preview': 'Vorschau',
    'mailTemplates.previewBody':
      'Mit Beispieldaten, so wie die E-Mail ankommt.',
    'mailTemplates.previewText': 'Text',
    'mailTemplates.previewHtml': 'HTML',
    'mailTemplates.from': 'Von:',
    'mailTemplates.to': 'An:',
    'mailTemplates.sampleNote':
      'Die Test-E-Mail enthält die gespeicherte Fassung mit Beispielwerten.',
    'mailTemplates.saved': '{kind} ({language}) gespeichert',
    'mailTemplates.reverted': 'Mitgelieferte Fassung gilt wieder',
    'confirm.mailTemplates.delete.title': 'Eigene Fassung löschen?',
    'confirm.mailTemplates.delete.body':
      'Ihre Fassung ({language}) wird gelöscht; danach gilt wieder der mitgelieferte Text.',
    'confirm.mailTemplates.delete.action': 'Zurücksetzen',
    'field.mailTemplate.subject': 'Betreff',
    'field.mailTemplate.bodyText': 'Text',
    'field.mailTemplate.bodyText.help':
      'Die reine Textfassung, die jedes E-Mail-Programm anzeigt.',
    'field.mailTemplate.bodyHtml': 'HTML-Fassung',
    'field.mailTemplate.bodyHtml.help':
      'Optional. Werte für Platzhalter werden darin sicher eingesetzt.',
    'errors.templateUnknownPlaceholder':
      'Den Platzhalter {{{name}}} gibt es für diese E-Mail nicht.',
    'errors.templateMissingRequired':
      'Der Platzhalter {{{name}}} muss vorkommen.',
    'errors.templateSyntax': 'Die Vorlage enthält einen Fehler: {message}',
    'errors.mailTemplateNoOverride': 'Es gibt keine eigene Fassung.',

    /* ---------- integrations ---------- */
    'integrations.subtitle':
      'KI-Assistenten, Webhooks und die REST-API anbinden.',
    'integrations.mcp.title': 'KI-Assistent verbinden',
    'integrations.mcp.body':
      'Claude, Codex und andere MCP-fähige Assistenten bedienen die Anlage per Chat – mit Ihren Rechten.',
    'integrations.mcp.other': 'Andere Assistenten (MCP-URL)',
    'integrations.mcp.step1': 'Befehl ausführen',
    'integrations.mcp.step1Body':
      'Im Terminal, oder die MCP-URL in den Einstellungen Ihres Assistenten eintragen.',
    'integrations.mcp.step2': 'Im Browser anmelden',
    'integrations.mcp.step2Body':
      'Der Assistent öffnet die Anmeldung der Anlage. Sie melden sich an und erlauben den Zugriff.',
    'integrations.mcp.step3': 'Loslegen',
    'integrations.mcp.step3Body':
      'Der Assistent kann genau das, was Ihre Rolle darf. Jede Änderung steht im Änderungsprotokoll, mit dem Namen des Assistenten.',
    'integrations.mcp.mucki':
      'Mucki, der Assistent hier in der Anlage, arbeitet genauso: mit Ihren Rechten, jede Änderung protokolliert.',
    'integrations.webhooks.title': 'Webhooks',
    'integrations.webhooks.body':
      'Die Anlage schickt Ereignisse an Ihre Systeme, etwa ein CRM. Jede Sendung ist mit dem Secret signiert.',
    'integrations.webhooks.empty': 'Noch keine Webhooks',
    'integrations.webhooks.emptyBody':
      'Lassen Sie Ihr CRM wissen, wenn ein Anruf klingelt oder eine Nachricht eingeht.',
    'integrations.webhook.add': 'Webhook anlegen',
    'integrations.webhook.edit': 'Webhook bearbeiten',
    'integrations.webhook.createdInactive':
      'Neue Webhooks starten ausgeschaltet – schalten Sie ihn ein, sobald Ihr System empfangsbereit ist.',
    'integrations.webhook.delivery': 'Zustellung',
    'integrations.webhook.allEvents': 'Alle Ereignisse',
    'integrations.webhook.allEventsHelp':
      'Auch Ereignisarten, die später dazukommen.',
    'integrations.webhook.inactive': 'Ausgeschaltet',
    'integrations.webhook.ok': 'Zustellung klappt',
    'integrations.webhook.noDelivery': 'Noch nichts zugestellt',
    'integrations.webhook.lastDelivery': 'zuletzt {at}',
    'integrations.webhook.lastError': 'Letzter Fehler {at}: {error}',
    'integrations.webhook.failingSince': 'Schlägt fehl seit {since}',
    'integrations.webhook.failedCount': '{count} Sendungen fehlgeschlagen',
    'integrations.webhook.generate': 'Erzeugen',
    'integrations.webhook.activeSwitch': 'Ereignisse zustellen',
    'integrations.webhook.created': 'Webhook angelegt – noch ausgeschaltet',
    'integrations.webhook.saved': 'Webhook gespeichert',
    'integrations.webhook.deleted': 'Webhook gelöscht',
    'integrations.webhook.activated': 'Webhook eingeschaltet',
    'integrations.webhook.deactivated': 'Webhook ausgeschaltet',
    'integrations.event.presence': 'Anwesenheit',
    'integrations.event.call.state': 'Anrufstatus',
    'integrations.event.voicemail.new': 'Neue Sprachnachricht',
    'integrations.event.ooo': 'Abwesenheit',
    'integrations.event.hours': 'Öffnungszeiten',
    'integrations.event.trunk.status': 'Trunk-Status',
    'integrations.event.sipBan.added': 'SIP-Sperre',
    'integrations.event.history.appended': 'Anrufverlauf',
    'integrations.event.backup.started': 'Backup gestartet',
    'integrations.event.backup.finished': 'Backup fertig',
    'integrations.event.backup.failed': 'Backup fehlgeschlagen',
    'integrations.tokens.title': 'Zugriffstoken',
    'integrations.tokens.body':
      'Für eigene Skripte und Programme, die die REST-API mit Ihren Rechten nutzen.',
    'integrations.tokens.open': 'Meine Zugriffstoken',
    'integrations.rest.title': 'REST-API',
    'integrations.rest.body':
      'Alles, was Sie hier und per KI-Assistent erledigen können – beschrieben als OpenAPI 3.1.',
    'integrations.rest.openapi': 'OpenAPI-Dokument',
    'integrations.rest.base': 'Basis-URL',
    'integrations.rest.auth':
      'Anmeldung per Header „Authorization: Bearer <Zugriffstoken>“. Aktionen, die eine Bestätigung verlangen, erwarten „confirm: true“.',
    'confirm.webhooks.delete.title': 'Webhook löschen?',
    'confirm.webhooks.delete.body':
      'An {url} werden keine Ereignisse mehr gesendet; noch ausstehende Sendungen werden verworfen.',
    'confirm.webhooks.delete.action': 'Löschen',
    'field.webhook.url': 'URL',
    'field.webhook.url.help':
      'Jedes Ereignis wird als JSON per POST an diese http(s)-Adresse geschickt.',
    'field.webhook.secret': 'Secret',
    'field.webhook.secret.help':
      'Jede Sendung trägt X-Zamfono-Signature, die HMAC-SHA256-Signatur des Inhalts mit diesem Secret. Wird nie wieder angezeigt.',
    'field.webhook.eventTypes': 'Ereignisse',
    'field.webhook.active': 'Aktiv',
    'errors.webhookUrl': 'Bitte eine http- oder https-Adresse angeben.',
    'errors.webhookSecret': 'Ein Secret ist Pflicht.',
    'errors.webhookEventTypes': 'Unbekannte Ereignisart.',

    /* ---------- backups ---------- */
    'backups.subtitle':
      'Verschlüsselte Sicherungen der Anlage mit allen Einstellungen, Aufnahmen und Nachrichten.',
    'backups.schedule.title': 'Zeitplan',
    'backups.schedule.change': 'Ändern',
    'backups.schedule.when': 'Läuft',
    'backups.schedule.next': 'Nächstes Backup',
    'backups.schedule.lastGood': 'Letztes erfolgreiches',
    'backups.schedule.never': 'noch nie',
    'backups.schedule.hint':
      'Jedes Backup geht an alle aktiven Ziele. Ein Update braucht ein erfolgreiches Backup aus der letzten Stunde.',
    'backups.targets.empty': 'Noch kein Backup-Ziel',
    'backups.targets.emptyBody':
      'Legen Sie mindestens ein Ziel an, am besten außer Haus.',
    'backups.target.add': 'Ziel anlegen',
    'backups.target.edit': 'Ziel bearbeiten',
    'backups.target.drawerBody':
      'Verschlüsselt und mit Versionen; unveränderte Daten werden nur einmal gespeichert.',
    'backups.target.disabled': 'Pausiert',
    'backups.target.lastRun': 'Letzter Lauf',
    'backups.target.size': 'Größe',
    'backups.target.keeps': 'Behält',
    'backups.target.scheduled': 'Nach Zeitplan sichern',
    'backups.target.created': 'Backup-Ziel angelegt',
    'backups.target.saved': 'Backup-Ziel gespeichert',
    'backups.target.deleted': 'Backup-Ziel gelöscht',
    'backups.target.enabledToast': 'Ziel wird wieder nach Zeitplan gesichert',
    'backups.target.disabledToast': 'Ziel pausiert',
    'backups.deletedTarget': 'Gelöschtes Ziel',
    'backups.run.now': 'Jetzt sichern',
    'backups.run.started': 'Backup läuft: {target}',
    'backups.forget.title': 'Aufbewahrung',
    'backups.forget.help':
      'Wie viele tägliche, wöchentliche und monatliche Stände bleiben; Standard 7 / 4 / 6.',
    'backups.forget.keepDaily': 'Tage',
    'backups.forget.keepWeekly': 'Wochen',
    'backups.forget.keepMonthly': 'Monate',
    'backups.forget.summary':
      '{keepDaily} T · {keepWeekly} W · {keepMonthly} M',
    'backups.kind.local': 'Lokal',
    'backups.kind.local.help':
      'Ein Verzeichnis oder Volume auf dem Server selbst. Schützt vor Fehlbedienung, nicht vor Verlust des Servers.',
    'backups.kind.ftp': 'FTP',
    'backups.kind.ftp.help':
      'Ein FTP-Server, z. B. ein NAS. Unverschlüsselte Übertragung – lieber FTPS oder SFTP.',
    'backups.kind.ftps': 'FTPS',
    'backups.kind.ftps.help': 'Ein FTP-Server mit TLS.',
    'backups.kind.sftp': 'SFTP',
    'backups.kind.sftp.help':
      'Ein Server mit SSH-Zugang, z. B. ein NAS im Büro.',
    'backups.kind.s3': 'S3',
    'backups.kind.s3.help':
      'Ein S3-kompatibler Objektspeicher (AWS, Wasabi, Hetzner, MinIO …).',
    'backups.kind.webdav': 'WebDAV',
    'backups.kind.webdav.help': 'Ein WebDAV-Speicher, z. B. Nextcloud.',
    'backups.param.path': 'Pfad',
    'backups.param.endpoint': 'Endpunkt',
    'backups.param.bucket': 'Bucket',
    'backups.param.host': 'Server',
    'backups.param.url': 'URL',
    'backups.param.path.placeholder.local': '/backups/restic',
    'backups.param.path.placeholder.s3': 'zamfono',
    'backups.param.path.placeholder.sftp': '/volume1/backup/zamfono',
    'backups.param.path.placeholder.ftp': '/backup/zamfono',
    'backups.param.path.placeholder.ftps': '/backup/zamfono',
    'backups.param.path.placeholder.webdav': 'zamfono',
    'backups.param.endpoint.placeholder.s3': 's3.eu-central-1.amazonaws.com',
    'backups.param.bucket.placeholder.s3': 'firma-telefonanlage',
    'backups.param.host.placeholder.sftp': 'nas.example.com',
    'backups.param.host.placeholder.ftp': 'nas.example.com',
    'backups.param.host.placeholder.ftps': 'nas.example.com',
    'backups.param.url.placeholder.webdav':
      'https://cloud.example.com/remote.php/dav/files/backup',
    'backups.secret.resticPassword': 'Backup-Passwort',
    'backups.secret.resticPasswordHelp':
      'Verschlüsselt die Sicherung. Bewahren Sie es zusätzlich sicher auf – ohne es lässt sich nichts wiederherstellen.',
    'backups.secret.username': 'Benutzername',
    'backups.secret.password': 'Passwort',
    'backups.secret.accessKeyId': 'Access-Key-ID',
    'backups.secret.secretAccessKey': 'Secret-Access-Key',
    'backups.secret.change': 'Zugangsdaten ändern',
    'backups.secret.replaceHelp':
      'Die Zugangsdaten werden immer vollständig ersetzt.',
    'backups.status.running': 'Läuft',
    'backups.status.ok': 'Erfolgreich',
    'backups.status.failed': 'Fehlgeschlagen',
    'backups.status.failedAt': 'Fehlgeschlagen {at}',
    'backups.runs.title': 'Verlauf',
    'backups.runs.allTargets': 'Alle Ziele',
    'backups.runs.started': 'Gestartet',
    'backups.runs.target': 'Ziel',
    'backups.runs.duration': 'Dauer',
    'backups.runs.added': 'Neu',
    'backups.runs.total': 'Gesamt',
    'backups.runs.snapshot': 'Snapshot',
    'backups.runs.empty': 'Noch keine Backups gelaufen',
    'confirm.backups.targets.delete.title': 'Backup-Ziel löschen?',
    'confirm.backups.targets.delete.body':
      'Auf {kind} {location} wird nicht mehr gesichert. Die vorhandenen Sicherungen dort bleiben erhalten.',
    'confirm.backups.targets.delete.action': 'Löschen',
    'field.backupTarget.kind': 'Art',
    'field.backupTarget.params': 'Speicherort',
    'field.backupTarget.secret': 'Zugangsdaten',
    'field.backupTarget.secret.help':
      'Werden verschlüsselt gespeichert und nie wieder angezeigt.',
    'field.backupTarget.enabled': 'Aktiv',
    'errors.backupHost':
      'Bitte einen Servernamen (FQDN) oder eine IPv4-Adresse angeben.',
    'errors.backupWebdavUrl': 'Bitte eine http- oder https-Adresse angeben.',
    'errors.backupSecretKind':
      'Für diese Art werden genau diese Zugangsdaten benötigt: {fields}.',
    'errors.backupSftpUsername':
      'Der Benutzername darf nicht mit - beginnen und keine Leerzeichen, Anführungszeichen oder Backslashes enthalten.',

    /* ---------- audit ---------- */
    'audit.subtitle':
      'Jede Änderung, wer sie gemacht hat und wie – mit Rückgängig, wo es geht.',
    'audit.filter.state': 'Zustand',
    'audit.filter.kind': 'Bereich',
    'audit.filter.actor': 'Wer',
    'audit.filter.operation': 'Was',
    'audit.filter.from': 'Ab',
    'audit.filter.to': 'Bis',
    'audit.filter.channel': 'Kanal',
    'audit.filter.client': 'Anwendung',
    'audit.filter.anyKind': 'Alle Bereiche',
    'audit.filter.anyone': 'Alle',
    'audit.filter.anyOperation': 'Alle Änderungen',
    'audit.filter.anyChannel': 'Alle Kanäle',
    'audit.filter.anyClient': 'Alle Anwendungen',
    'audit.filter.reset': 'Filter zurücksetzen',
    'audit.state.live': 'Aktuell',
    'audit.state.undone': 'Rückgängig gemacht',
    'audit.state.all': 'Alle',
    'audit.channel.ui': 'Weboberfläche',
    'audit.channel.mcp': 'KI-Assistent',
    'audit.channel.rest': 'REST-API',
    'audit.channel.undo': 'Rückgängig',
    'audit.channel.job': 'Automatisch',
    'audit.empty': 'Keine Einträge',
    'audit.emptyFiltered': 'Kein Eintrag passt zu den Filtern.',
    'audit.emptyList': 'leer',
    'audit.more': '{count} weitere anzeigen',
    'audit.notUndoable': 'nicht umkehrbar',
    'audit.undoneBadge': 'Rückgängig gemacht {at}',
    'audit.reverts': 'macht rückgängig: {what}',
    'audit.verb.create': '{kind} angelegt',
    'audit.verb.update': '{kind} geändert',
    'audit.verb.delete': '{kind} gelöscht',
    'audit.verb.other': '{operation}',
    'audit.kind.user': 'Benutzer',
    'audit.kind.device': 'Gerät',
    'audit.kind.ringGroup': 'Rufgruppe',
    'audit.kind.userGroup': 'Benutzergruppe',
    'audit.kind.menu': 'Sprachmenü',
    'audit.kind.did': 'Rufnummer',
    'audit.kind.didBlock': 'Nummernblock',
    'audit.kind.trunk': 'SIP-Trunk',
    'audit.kind.webhook': 'Webhook',
    'audit.kind.contact': 'Kontakt',
    'audit.kind.audio': 'Audiodatei',
    'audit.kind.oooRule': 'Abwesenheit',
    'audit.kind.openingHours': 'Öffnungszeiten',
    'audit.kind.backupTarget': 'Backup-Ziel',
    'audit.kind.backupRun': 'Backup',
    'audit.kind.blockedNumber': 'Gesperrte Nummer',
    'audit.kind.sipAllowlistEntry': 'SIP-Freigabe',
    'audit.kind.sipBan': 'SIP-Sperre',
    'audit.kind.settings': 'Einstellungen',
    'audit.kind.outboundRoute': 'Ausgehende Routen',
    'audit.kind.parking': 'Parkplätze',
    'audit.kind.personalAccessToken': 'Zugriffstoken',
    'audit.kind.mailTemplate': 'E-Mail-Vorlage',
    'audit.kind.system': 'System',
    'audit.kind.voicemail': 'Sprachnachricht',
    'audit.kind.recording': 'Aufzeichnung',
    'audit.op.users.create': 'Benutzer angelegt',
    'audit.op.users.update': 'Benutzer geändert',
    'audit.op.users.delete': 'Benutzer gelöscht',
    'audit.op.users.resetPassword': 'Passwort-Link verschickt',
    'audit.op.users.resetMfa': 'Zwei-Faktor-Anmeldung zurückgesetzt',
    'audit.op.users.erase': 'Benutzerdaten endgültig gelöscht',
    'audit.op.users.setForwarding': 'Weiterleitungen geändert',
    'audit.op.devices.create': 'Gerät hinzugefügt',
    'audit.op.devices.update': 'Gerät geändert',
    'audit.op.devices.delete': 'Gerät entfernt',
    'audit.op.devices.rotate': 'Gerätepasswort erneuert',
    'audit.op.devices.revealCredentials': 'Zugangsdaten eines Geräts angezeigt',
    'audit.op.devices.setBlf': 'Tasten-Panel geändert',
    'audit.op.personalAccessTokens.create': 'Zugriffstoken erstellt',
    'audit.op.personalAccessTokens.revoke': 'Zugriffstoken widerrufen',
    'audit.op.provisioning.ringotelSetup': 'Ringotel eingerichtet',
    'audit.op.provisioning.ringotelAdopt': 'Ringotel-Organisation übernommen',
    'audit.op.trunks.create': 'SIP-Trunk angelegt',
    'audit.op.trunks.update': 'SIP-Trunk geändert',
    'audit.op.trunks.delete': 'SIP-Trunk gelöscht',
    'audit.op.trunks.setOrder': 'Notruf-Reihenfolge der Trunks geändert',
    'audit.op.trunks.reregister': 'Trunk neu angemeldet',
    'audit.op.outboundRoutes.replace': 'Ausgehende Routen geändert',
    'audit.op.dids.create': 'Rufnummer angelegt',
    'audit.op.dids.update': 'Rufnummer geändert',
    'audit.op.dids.delete': 'Rufnummer gelöscht',
    'audit.op.didBlocks.create': 'Nummernblock angelegt',
    'audit.op.didBlocks.update': 'Nummernblock geändert',
    'audit.op.didBlocks.delete': 'Nummernblock gelöscht',
    'audit.op.ringGroups.create': 'Rufgruppe angelegt',
    'audit.op.ringGroups.update': 'Rufgruppe geändert',
    'audit.op.ringGroups.delete': 'Rufgruppe gelöscht',
    'audit.op.ringGroups.setForwarding': 'Weiterleitung der Rufgruppe geändert',
    'audit.op.userGroups.create': 'Benutzergruppe angelegt',
    'audit.op.userGroups.update': 'Benutzergruppe geändert',
    'audit.op.userGroups.delete': 'Benutzergruppe gelöscht',
    'audit.op.audio.create': 'Audiodatei hochgeladen',
    'audit.op.audio.update': 'Audiodatei geändert',
    'audit.op.audio.delete': 'Audiodatei gelöscht',
    'audit.op.voicemails.delete': 'Sprachnachricht gelöscht',
    'audit.op.recordings.delete': 'Aufzeichnung gelöscht',
    'audit.op.contacts.create': 'Kontakt angelegt',
    'audit.op.contacts.update': 'Kontakt geändert',
    'audit.op.contacts.delete': 'Kontakt gelöscht',
    'audit.op.blockedNumbers.create': 'Nummer gesperrt',
    'audit.op.blockedNumbers.delete': 'Nummernsperre aufgehoben',
    'audit.op.sipBans.ban': 'Adresse wegen Fehlversuchen gesperrt',
    'audit.op.sipBans.lift': 'SIP-Sperre aufgehoben',
    'audit.op.sipAllowlist.create': 'Adresse für SIP freigegeben',
    'audit.op.sipAllowlist.delete': 'SIP-Freigabe entfernt',
    'audit.op.parking.set': 'Parkplätze geändert',
    'audit.op.menus.create': 'Sprachmenü angelegt',
    'audit.op.menus.update': 'Sprachmenü geändert',
    'audit.op.menus.delete': 'Sprachmenü gelöscht',
    'audit.op.menus.setTargets': 'Tasten des Sprachmenüs geändert',
    'audit.op.ooo.create': 'Abwesenheit eingetragen',
    'audit.op.ooo.update': 'Abwesenheit geändert',
    'audit.op.ooo.delete': 'Abwesenheit gelöscht',
    'audit.op.hours.set': 'Öffnungszeiten geändert',
    'audit.op.hours.delete': 'Öffnungszeiten entfernt',
    'audit.op.webhooks.create': 'Webhook angelegt',
    'audit.op.webhooks.update': 'Webhook geändert',
    'audit.op.webhooks.delete': 'Webhook gelöscht',
    'audit.op.mailTemplates.put': 'E-Mail-Vorlage angepasst',
    'audit.op.mailTemplates.delete': 'E-Mail-Vorlage zurückgesetzt',
    'audit.op.mailTemplates.test': 'Test-E-Mail verschickt',
    'audit.op.backups.targets.create': 'Backup-Ziel angelegt',
    'audit.op.backups.targets.update': 'Backup-Ziel geändert',
    'audit.op.backups.targets.delete': 'Backup-Ziel gelöscht',
    'audit.op.backups.runs.start': 'Backup von Hand gestartet',
    'audit.op.settings.update': 'Einstellungen geändert',
    'audit.op.system.update': 'Update gestartet',
    'audit.op.system.autoUpdate': 'Automatisches Update',
    'audit.op.system.maintenanceGate': 'Wartung verschoben',
    'audit.op.audit.undo': 'Änderung rückgängig gemacht',
    'audit.op.ringotel.push': 'Gerät an Ringotel übertragen',
    'audit.op.ringotel.profile': 'Profil an Ringotel übertragen',
    'audit.op.ringotel.roster': 'Kollegenliste an Ringotel übertragen',
    'audit.op.ringotel.rereg': 'Ringotel-Apps neu angemeldet',
    'errors.undoNoEntity':
      'Diese Änderung betrifft keinen einzelnen Eintrag und lässt sich daher nicht rückgängig machen.',
    'errors.undoPurged': 'Der Eintrag wurde inzwischen endgültig gelöscht:',

    /* ---------- system & updates ---------- */
    'system.subtitle': 'Versionen, Updates und der Zustand der Anlage.',
    'system.check.now': 'Nach Updates suchen',
    'system.check.available': 'Version {version} ist verfügbar',
    'system.check.current': 'Die Anlage ist auf dem neuesten Stand',
    'system.update.title': 'Update',
    'system.update.available':
      'Neue Version – Sie nutzen {current}. Veröffentlicht am {date}.',
    'system.update.notes': 'Was ist neu?',
    'system.update.backupOk': 'Backup vorhanden ({at}) – bereit zum Update.',
    'system.update.backupNeeded':
      'Ein Update braucht ein erfolgreiches Backup aus der letzten Stunde (letztes: {at}).',
    'system.update.backupRunning':
      'Backup läuft – danach kann das Update starten.',
    'system.update.toBackups': 'Zu den Backups',
    'system.update.now': 'Jetzt aktualisieren',
    'system.update.ownerOnly': 'Updates spielen Inhaber:innen ein.',
    'system.update.breaking':
      'Version {version} enthält größere Änderungen und muss auf dem Server mit update.sh eingespielt werden.',
    'system.update.upToDate': 'Auf dem neuesten Stand ({version})',
    'system.update.last': 'Letztes Update',
    'system.update.never': 'Noch keines',
    'system.update.lastLine': '{from} → {to}',
    'system.update.state.running': 'Läuft',
    'system.update.state.succeeded': 'Erfolgreich',
    'system.update.state.failed': 'Fehlgeschlagen',
    'system.update.trigger.manual': 'Von {by} gestartet',
    'system.update.trigger.automatic': 'Automatisch',
    'system.update.trigger.host': 'Auf dem Server',
    'system.update.started': 'Update gestartet – die Anlage startet gleich neu',
    'system.maintenance.title': 'Update auf {version} läuft',
    'system.maintenance.body':
      'Laufende Gespräche brechen ab, während die Anlage neu startet. Das dauert meist ein bis zwei Minuten.',
    'system.versions.title': 'Versionen',
    'system.versions.api': 'API',
    'system.versions.core': 'Telefonie-Kern',
    'system.versions.coreDown': 'antwortet nicht',
    'system.versions.apiStarted': 'Läuft seit',
    'system.versions.asteriskStarted': 'Telefonie-Kern läuft seit',
    'system.stack.domain': 'Adresse',
    'system.stack.ipv4': 'Öffentliche IPv4',
    'system.auto.title': 'Automatische Updates',
    'system.auto.onBody':
      'Neue kompatible Versionen kommen nach einem Backup von selbst.',
    'system.auto.offBody': 'Updates werden von Hand eingespielt.',
    'system.auto.failed':
      'Letztes automatisches Update nach {attempts} Versuchen fehlgeschlagen: {error}',
    'system.goSettings': 'Einstellungen',
    'system.mail.title': 'Mailserver',
    'system.mail.none': 'Nicht eingerichtet',
    'system.mail.ok': 'Erreichbar',
    'system.relayError.unreachable': 'nicht erreichbar',
    'system.relayError.tls': 'TLS-Fehler',
    'system.relayError.authentication': 'Anmeldung abgelehnt',
    'system.relayError.rejected': 'E-Mail abgelehnt',
    'system.ringotel.title': 'Ringotel',
    'system.ringotel.inSync': 'Auf dem neuesten Stand',
    'system.ringotel.pending': 'Übertragung ausstehend',
    'system.ringotel.profile': 'Profil',
    'system.ringotel.roster': 'Kollegenliste',
    'system.ringotel.body':
      'Änderungen an Codecs, Funktionscodes und Personen werden automatisch an die Apps übertragen.',
    'system.skipped.title': 'Übersprungene Konfiguration',
    'system.skipped.body':
      'Einträge, die bei der letzten Konfiguration ausgelassen wurden, weil der Telefonie-Kern einen ihrer Werte nicht verarbeiten kann.',
    'system.skipped.none': 'Keine – alles wurde übernommen',
    'system.skipped.type': 'Art',
    'system.skipped.field': 'Feld',
    'system.unit.1': 'Sekunden',
    'system.unit.60': 'Minuten',
    'system.unit.3600': 'Stunden',
    'system.unit.86400': 'Tage',
    'system.cron.daily': 'Täglich um {time} Uhr',
    'system.cron.weekly': 'Jeden {days} um {time} Uhr',
    'system.cron.monthly': 'Monatlich am {day}. um {time} Uhr',
    'system.cron.everyHours':
      'Alle {hours} Stunden, jeweils zur Minute {minute}',
    'system.cron.custom': 'Eigener Zeitplan',
    'system.cron.next': 'Nächste: {runs}',
    'system.cron.invalid':
      'Kein gültiger Cron-Ausdruck (Minute Stunde Tag Monat Wochentag).',
    'system.weekday.mon': 'Montag',
    'system.weekday.tue': 'Dienstag',
    'system.weekday.wed': 'Mittwoch',
    'system.weekday.thu': 'Donnerstag',
    'system.weekday.fri': 'Freitag',
    'system.weekday.sat': 'Samstag',
    'system.weekday.sun': 'Sonntag',
    'confirm.system.update.title': 'Auf {version} aktualisieren?',
    'confirm.system.update.body':
      'Laufende Gespräche brechen ab, während die Anlage neu startet. Zurück geht es nur über die Wiederherstellung des Backups.',
    'confirm.system.update.action': 'Jetzt aktualisieren',
    'field.systemUpdate.version': 'Zielversion',
    'field.systemUpdate.version.help': 'Leer: die neueste Version.',
    'errors.updateNeedsBackup':
      'Erst ein Backup: Ein Update braucht ein erfolgreiches Backup aus der letzten Stunde.',
    'errors.updateRunning': 'Es läuft bereits ein Update.',
    'errors.updateNothingNewer':
      'Es gibt keine neuere Version, die sich hier einspielen lässt.',
    'errors.updateVersionFormat': 'Bitte eine Version im Format 0.5.0 angeben.',
    'errors.updateVersionUnknown': 'Die Version {version} gibt es nicht.',

    /* ---------- ringotel ---------- */
    'ringotel.subtitle':
      'Verbindet die Anlage mit Ringotel, damit die App auf Smartphone und Computer sich von selbst einrichtet.',
    'ringotel.what.title': 'Was passiert dabei?',
    'ringotel.what.point1':
      'Die Anlage legt bei Ringotel eine Organisation und eine Verbindung zu sich an.',
    'ringotel.what.point2':
      'Jede Person mit einem App-Gerät bekommt automatisch einen Ringotel-Zugang und eine Einladung.',
    'ringotel.what.point3':
      'Funktionscodes, Codecs, Sprache und die Kollegenliste werden laufend an die App übertragen.',
    'ringotel.status.title': 'Status',
    'ringotel.status.connected': 'Verbunden',
    'ringotel.status.connectedBody':
      'App-Geräte werden automatisch eingerichtet.',
    'ringotel.status.notConnected': 'Noch nicht verbunden',
    'ringotel.status.notConnectedBody': 'Richten Sie Ringotel unten ein.',
    'ringotel.status.org': 'Organisation',
    'ringotel.status.branch': 'Verbindung',
    'ringotel.status.noToken': 'fehlt',
    'ringotel.status.sync': 'Abgleich',
    'ringotel.toSettings': 'Token & Geräte pro Person',
    'ringotel.setup.title': 'Einrichten',
    'ringotel.setup.titleConnected': 'Einrichten oder übernehmen',
    'ringotel.setup.body':
      'Neue Organisation anlegen oder eine bestehende, leere übernehmen.',
    'ringotel.setup.connectedBody':
      'Gilt nur für eine Anlage, die noch nicht verbunden ist – diese ist es bereits.',
    'ringotel.setup.show': 'Anzeigen',
    'ringotel.setup.hide': 'Ausblenden',
    'ringotel.setup.needsToken':
      'Hinterlegen Sie zuerst den Ringotel-API-Token in den Einstellungen.',
    'ringotel.setup.new': 'Neue Organisation',
    'ringotel.setup.adopt': 'Bestehende übernehmen',
    'ringotel.setup.newBody':
      'Legt die Organisation unter Ihrem Firmennamen an. Die Region lässt sich danach nicht mehr ändern.',
    'ringotel.setup.adoptBody':
      'Für eine Organisation, die in der Ringotel-Shell angelegt wurde. Sie darf noch keine Benutzer haben.',
    'ringotel.setup.branchPlaceholder': 'leer: neue Verbindung anlegen',
    'ringotel.setup.create': 'Organisation anlegen',
    'ringotel.setup.adoptAction': 'Übernehmen',
    'ringotel.setup.expert':
      'Ringotel-Domain, Region und Paket werden danach nur bei Ringotel verwaltet; die Anlage merkt sich Organisations- und Verbindungs-ID.',
    'ringotel.package': '{name} ({regs} Geräte pro Person)',
    'ringotel.connectedToast': 'Ringotel eingerichtet',
    'ringotel.adoptedToast': 'Ringotel-Organisation übernommen',
    'confirm.provisioning.ringotelAdopt.title': 'Organisation übernehmen?',
    'confirm.provisioning.ringotelAdopt.body':
      'Die Ringotel-Organisation {domain} bekommt eine neue Verbindung zu dieser Anlage.',
    'confirm.provisioning.ringotelAdopt.action': 'Übernehmen',
    'confirm.provisioning.ringotelAdoptBranch.title':
      'Organisation übernehmen?',
    'confirm.provisioning.ringotelAdoptBranch.body':
      'Die Verbindung {branchId} der Ringotel-Organisation {domain} wird auf diese Anlage umgestellt.',
    'confirm.provisioning.ringotelAdoptBranch.action': 'Übernehmen',
    'field.ringotel.domain': 'Ringotel-Domain',
    'field.ringotel.domain.help':
      'Weltweit eindeutig, z. B. der Firmenname ohne Leerzeichen.',
    'field.ringotel.region': 'Region',
    'field.ringotel.region.help':
      'Wo die Daten liegen; lässt sich später nicht ändern.',
    'field.ringotel.packageid': 'Paket',
    'field.ringotel.orgId': 'Organisations-ID',
    'field.ringotel.orgId.help':
      'Steht in der Ringotel-Shell bei der Organisation.',
    'field.ringotel.branchId': 'Verbindungs-ID',
    'field.ringotel.branchId.help':
      'Optional: eine bestehende Verbindung weiterverwenden.',
    'errors.ringotelAlreadySetUp':
      'Ringotel ist bereits eingerichtet (Organisation {orgId}).',
    'errors.ringotelNoToken':
      'Erst den Ringotel-API-Token in den Einstellungen hinterlegen.',
    'errors.ringotelRegion': 'Diese Region bietet Ringotel nicht an: {list}.',
    'errors.ringotelPackage': 'Dieses Paket bietet Ringotel nicht an: {list}.',
    'errors.ringotelDomainTaken':
      'Es gibt schon eine Organisation {domain} (ID {orgId}). Gehört sie zu dieser Anlage, übernehmen Sie sie.',
    'errors.ringotelOrgHasUsers':
      'Die Organisation hat schon {users} Benutzer; übernommen wird nur eine leere.',

    /* ---------- SIP protection ---------- */
    'sipProtection.subtitle':
      'Adressen, die sich zu oft mit falschen Zugangsdaten anzumelden versuchen, werden gesperrt.',
    'sipProtection.activeCount': '{count} aktive Sperren',
    'sipProtection.bans.title': 'Sperren',
    'sipProtection.bans.body':
      'Gesperrte Adressen erreichen die SIP-Ports nicht mehr; die Weboberfläche bleibt erreichbar.',
    'sipProtection.bans.active': 'Aktiv',
    'sipProtection.bans.ended': 'Beendet',
    'sipProtection.bans.address': 'Adresse',
    'sipProtection.bans.step': 'Stufe',
    'sipProtection.bans.stepN': '{n}. Sperre',
    'sipProtection.bans.failures': 'Fehlversuche',
    'sipProtection.bans.since': 'Seit',
    'sipProtection.bans.until': 'Bis',
    'sipProtection.bans.permanent': 'Dauerhaft',
    'sipProtection.bans.expires': 'endet {at}',
    'sipProtection.bans.expired': 'abgelaufen {at}',
    'sipProtection.bans.liftedBy': 'aufgehoben {at} von {by}',
    'sipProtection.bans.lift': 'Aufheben',
    'sipProtection.bans.lifted': 'Sperre für {address} aufgehoben',
    'sipProtection.bans.emptyActive': 'Keine aktiven Sperren',
    'sipProtection.bans.empty': 'Keine Sperren',
    'sipProtection.allow.title': 'Freigaben',
    'sipProtection.allow.body':
      'Diese Adressen und Netze werden nie gesperrt, z. B. Ihr Büro. Eine neue Freigabe beendet passende Sperren sofort.',
    'sipProtection.allow.add': 'Freigeben',
    'sipProtection.allow.added': '{address} freigegeben',
    'sipProtection.allow.deleted': 'Freigabe entfernt',
    'sipProtection.allow.labelPlaceholder': 'z. B. Büro München',
    'sipProtection.allow.empty': 'Noch keine Freigaben.',
    'sipProtection.rules.title': 'Sperrregeln',
    'sipProtection.rules.summary':
      '{failures} Fehlversuche in {window} sperren eine Adresse: {steps}.',
    'sipProtection.rules.off': 'Sperren sind ausgeschaltet.',
    'sipProtection.steps.on': 'Adressen sperren',
    'sipProtection.steps.offHelp':
      'Wenn ausgeschaltet, werden keine neuen Sperren verhängt und bestehende nicht mehr durchgesetzt.',
    'sipProtection.steps.nth': '{n}. Sperre',
    'sipProtection.steps.permanent': 'dauerhaft',
    'sipProtection.steps.permanentShort': 'dauerhaft',
    'sipProtection.steps.add': 'Stufe hinzufügen',
    'sipProtection.steps.lastPermanent': 'Letzte Stufe dauerhaft',
    'confirm.sipBans.lift.title': 'Sperre aufheben?',
    'confirm.sipBans.lift.body':
      '{address} erreicht die SIP-Ports sofort wieder. Häufen sich erneut Fehlversuche, wird die Adresse wieder gesperrt.',
    'confirm.sipBans.lift.action': 'Aufheben',
    'confirm.sipAllowlist.delete.title': 'Freigabe entfernen?',
    'confirm.sipAllowlist.delete.body':
      '{address} kann danach wieder gesperrt werden.',
    'confirm.sipAllowlist.delete.action': 'Entfernen',
    'field.sipAllowlistEntry.address': 'Adresse oder Netz',
    'field.sipAllowlistEntry.address.help':
      'Eine IP-Adresse oder ein Bereich in CIDR-Schreibweise, IPv4 oder IPv6, z. B. 198.51.100.0/24.',
    'field.sipAllowlistEntry.label': 'Notiz',
    'errors.sipAllowlistAddress':
      'Bitte eine IP-Adresse oder ein Netz wie 198.51.100.0/24 angeben.',
    'errors.sipBanEnded': 'Diese Sperre ist schon beendet.'
  },
  en: {
    /* ---------- settings ---------- */
    'settings.subtitle':
      'The basics of your phone system. Each section is saved separately.',
    'settings.tab.general': 'General',
    'settings.tab.calls': 'Calls & voicemail',
    'settings.tab.featureCodes': 'Feature codes',
    'settings.tab.mail': 'E-mail',
    'settings.tab.signIn': 'Sign-in & SSO',
    'settings.tab.retention': 'Retention',
    'settings.tab.updates': 'Updates',
    'settings.tab.ringotel': 'Ringotel',
    'settings.saved': 'Settings saved',
    'settings.unsaved': 'Unsaved changes',
    'settings.discard': 'Discard',
    'settings.card.company': 'Company',
    'settings.card.companyBody':
      'Name, main number and the language of prompts and e-mails.',
    'settings.card.region': 'Region',
    'settings.card.regionBody':
      'Country and time zone for phone numbers and all times shown.',
    'settings.card.calls': 'Calls',
    'settings.card.callsBody':
      'Defaults for everyone; each person can override them.',
    'settings.card.limits': 'Voicemail & parking',
    'settings.card.limitsBody':
      'How long messages may be and parked calls wait.',
    'settings.card.fallback': 'Unassigned numbers',
    'settings.card.fallbackBody':
      'Where calls go to numbers that have no target.',
    'settings.card.featureCodes': 'Feature codes',
    'settings.card.featureCodesBody':
      'Codes dialled on the phone. Each starts with * or #, and none may be the start of another.',
    'settings.card.emergency': 'Emergency numbers',
    'settings.card.emergencyBody':
      'Always dialled out as emergency calls and never valid as extensions.',
    'settings.card.mail': 'Mail server',
    'settings.card.mailBody':
      'The system sends voicemails, invitations and notices through this server.',
    'settings.card.mfa': 'Two-factor sign-in',
    'settings.card.mfaBody':
      'Owners and admins always sign in with a second factor.',
    'settings.card.sso': 'Single sign-on',
    'settings.card.ssoBody':
      'Sign in with the company account at Microsoft, Google or an OIDC provider.',
    'settings.card.retention': 'Retention',
    'settings.card.retentionBody':
      'How long data is kept. Leave empty to keep it forever.',
    'settings.card.updates': 'Updates',
    'settings.card.updatesBody':
      'How new versions of the phone system are installed.',
    'settings.card.backupSchedule': 'Backup schedule',
    'settings.card.backupScheduleBody':
      'When the automatic backup runs to every enabled target.',
    'settings.card.ringotel': 'Ringotel app',
    'settings.card.ringotelBody':
      'The smartphone and desktop app for your team.',
    'settings.language.de': 'German',
    'settings.language.en': 'English',
    'settings.language.es': 'Spanish',
    'settings.language.fr': 'French',
    'settings.language.it': 'Italian',
    'settings.language.ru': 'Russian',
    'settings.timezone.stack': "The server's time zone",
    'settings.extLength.value': '{digits} digits',
    'settings.clir.switch': 'Withhold our number on outbound calls',
    'settings.rejectAnonymous.switch':
      'Refuse callers who withhold their number',
    'settings.moh.builtin': 'Built-in hold music',
    'settings.codecs.add': 'Add a codec …',
    'settings.codec.opus': 'Opus (HD, adapts to the line)',
    'settings.codec.g722': 'G.722 (HD)',
    'settings.codec.amrwb': 'AMR-WB (HD mobile)',
    'settings.codec.amr': 'AMR (mobile)',
    'settings.codec.alaw': 'G.711 A-law (Europe)',
    'settings.codec.ulaw': 'G.711 µ-law (North America)',
    'settings.callLogLevel.none': 'Off',
    'settings.callLogLevel.events': 'Routing',
    'settings.callLogLevel.qos': '+ Quality',
    'settings.callLogLevel.sip': '+ SIP',
    'settings.fallback.none': 'Refuse the call',
    'settings.fc.pickup': 'Pick up',
    'settings.fc.pickup.help':
      'Plus extension: answers a call ringing at someone else.',
    'settings.fc.dndOn': 'Do not disturb on',
    'settings.fc.dndOn.help': 'Turns do not disturb on for you.',
    'settings.fc.dndOff': 'Do not disturb off',
    'settings.fc.dndOff.help': 'Turns do not disturb off again.',
    'settings.fc.mailbox': 'Check a mailbox',
    'settings.fc.mailbox.help':
      'Plus extension: listens to a mailbox (with PIN).',
    'settings.fc.ownVoicemail': 'Own voicemail',
    'settings.fc.ownVoicemail.help': 'Opens your own mailbox directly.',
    'settings.fc.deposit': 'Leave a message',
    'settings.fc.deposit.help':
      'Plus extension: goes straight to the mailbox without ringing.',
    'settings.fc.addParty': 'Add a party',
    'settings.fc.addParty.help':
      'Plus number, during a call: brings in a third person.',
    'settings.fc.clirOn': 'Withhold number',
    'settings.fc.clirOn.help':
      'Before the number: this call goes out without your number.',
    'settings.fc.clirOff': 'Show number',
    'settings.fc.clirOff.help':
      'Before the number: this call shows your number.',
    'settings.fc.park': 'Park',
    'settings.fc.park.help': 'During a call: parks it on a free parking slot.',
    'settings.emergency.digits': 'Digits only.',
    'settings.mail.noRelay': 'No mail server – no e-mails are sent',
    'settings.smtpSecurity.tls': 'TLS (encrypted from the start)',
    'settings.smtpSecurity.starttls': 'STARTTLS',
    'settings.smtpCheck.none': 'only at start and on changes',
    'settings.mail.statusOk': 'Mail server reachable',
    'settings.mail.statusFailing': 'The mail server reports an error: {class}',
    'settings.mail.statusNone': 'No mail server set up',
    'settings.mail.statusNoneBody':
      'Without a server and sender the system sends no e-mails.',
    'settings.mail.checkedAt': 'Last checked {at}',
    'settings.mail.templatesHint':
      'Change the wording of the e-mails in the mail templates.',
    'settings.mail.fromPlaceholder': 'Phone system <phone@example.com>',
    'settings.mfa.switch': 'Require a second factor from everyone',
    'settings.mfa.on': 'Required for everyone',
    'settings.mfa.off': 'Only owners and admins',
    'settings.sso.provider.none': 'Off',
    'settings.sso.provider.microsoft': 'Microsoft',
    'settings.sso.provider.google': 'Google',
    'settings.sso.provider.oidc': 'OIDC',
    'settings.sso.labelPlaceholder': 'Sign in with your company account',
    'settings.sso.labelDefault': "The provider's default text",
    'settings.sso.anyDomain': 'Any domain',
    'settings.sso.resetWarning':
      "Saving unlinks {count} people's SSO sign-in. They link their account again at their next sign-in.",
    'settings.retention.forever': 'forever',
    'settings.retention.days': '{days} days',
    'settings.autoUpdate.switch': 'Install new versions automatically',
    'settings.autoUpdate.on': 'Automatic',
    'settings.autoUpdate.off': 'Manual only',
    'settings.tlsReloadHour.none': 'Not set',
    'settings.ringotel.status': 'Connection',
    'settings.ringotel.connected': 'Connected',
    'settings.ringotel.notConnected': 'Not set up',
    'settings.ringotel.orgId': 'Organization ID',
    'settings.ringotel.branchId': 'Connection ID',
    'settings.ringotel.maxRegsValue': '{count} devices per person',
    'settings.ringotel.pushPending': 'Sending the change to Ringotel …',

    'field.settings.companyName': 'Company name',
    'field.settings.companyName.help':
      'Shown in e-mails and on the sign-in page.',
    'field.settings.mainDidId': 'Main number',
    'field.settings.mainDidId.help':
      'Presented on outbound calls when neither the route nor the person sets a number.',
    'field.settings.country': 'Country',
    'field.settings.country.help':
      'Its calling code turns 089 … into the international form +4989 ….',
    'field.settings.timezone': 'Time zone',
    'field.settings.timezone.help':
      'Used for opening hours, out-of-office periods and every time shown.',
    'field.settings.language': 'Language',
    'field.settings.language.help':
      'The language of the prompts callers hear, the e-mails and the sign-in pages.',
    'field.settings.extLength': 'Extension length',
    'field.settings.extLength.help': 'Fixed when the system was set up.',
    'field.settings.smtpHost': 'Server',
    'field.settings.smtpHost.help': 'Empty: no e-mails are sent.',
    'field.settings.smtpPort': 'Port',
    'field.settings.smtpPort.help': 'Usually 465 (TLS) or 587 (STARTTLS).',
    'field.settings.smtpSecurity': 'Encryption',
    'field.settings.smtpSecurity.help':
      'TLS encrypts right away; STARTTLS upgrades a plain connection.',
    'field.settings.smtpUser': 'User name',
    'field.settings.smtpPassword': 'Password',
    'field.settings.smtpPassword.help':
      'Never shown again, only whether one is set.',
    'field.settings.mailFrom': 'Sender',
    'field.settings.mailFrom.help':
      'The server must be allowed to send for its domain. Empty: no e-mails.',
    'field.settings.smtpCheckIntervalS': 'Check interval',
    'field.settings.smtpCheckIntervalS.help':
      'How often the system checks the mail server in the background (60 to 86400 seconds).',
    'field.settings.emergencyNumbers': 'Emergency numbers',
    'field.settings.emergencyNumbers.help':
      'Must not be an existing extension.',
    'field.settings.featureCodes': 'Feature codes',
    'field.settings.fallbackTarget': 'Target',
    'field.settings.fallbackTarget.help':
      'For numbers in a number block without a target of their own, and for every unknown number. Without a target the call is refused.',
    'field.settings.codecs': 'Codecs',
    'field.settings.codecs.help':
      'The order codecs are offered to devices and to trunks without their own list; the first is preferred.',
    'field.settings.clir': 'Withhold number',
    'field.settings.clir.help':
      'Default; a trunk, a person and the #31# code override it.',
    'field.settings.rejectAnonymous': 'Anonymous calls',
    'field.settings.rejectAnonymous.help':
      'Default; each person can change it for themselves.',
    'field.settings.holdMohAudioId': 'Hold music',
    'field.settings.holdMohAudioId.help': 'What callers hear while on hold.',
    'field.settings.voicemailMaxS': 'Message length',
    'field.settings.voicemailMaxS.help':
      'At most this many seconds; 180 by default.',
    'field.settings.parkingTimeoutS': 'Parking time',
    'field.settings.parkingTimeoutS.help':
      'Then a parked call rings the person who parked it again; 300 by default.',
    'field.settings.callLogLevel': 'Diagnostics level',
    'field.settings.callLogLevel.help':
      'What is logged for every call: routing (the default), plus call quality, plus a SIP capture.',
    'field.settings.recordingRetentionDays': 'Recordings & call history',
    'field.settings.recordingRetentionDays.help':
      'Also covers call logs, call quality, the presence log and backup runs. 90 days by default.',
    'field.settings.softDeleteRetentionDays': 'Deleted entries',
    'field.settings.softDeleteRetentionDays.help':
      'How long a deletion can be undone. At most as long as the audit log is kept.',
    'field.settings.auditRetentionDays': 'Audit log',
    'field.settings.auditRetentionDays.help': 'At least 30 days.',
    'field.settings.sipBanFailures': 'Failed attempts before a ban',
    'field.settings.sipBanFailures.help':
      'This many failed SIP sign-ins from one address within the window ban it; 10 by default.',
    'field.settings.sipBanWindowS': 'Window',
    'field.settings.sipBanWindowS.help':
      'The period failed attempts are counted over; 1 hour by default.',
    'field.settings.sipBanSuccessExemptS': 'Grace after a successful sign-in',
    'field.settings.sipBanSuccessExemptS.help':
      'An address is never banned this long after it signed in successfully; 0 grants none. 1 day by default.',
    'field.settings.sipBanLookbackS': 'Repeat period',
    'field.settings.sipBanLookbackS.help':
      'An address banned again within this time after its last ban ended gets the next step; 30 days by default.',
    'field.settings.sipBanSteps': 'Ban steps',
    'field.settings.sipBanSteps.help':
      "The length of an address's first, second, … ban, each longer than the one before. Applies to new bans only.",
    'field.settings.backupCron': 'Schedule',
    'field.settings.backupCron.help':
      'Cron expression: minute, hour, day, month, weekday. 0 3 * * * (daily at 3 am) by default.',
    'field.settings.tlsReloadHour': 'Hour for certificate swaps',
    'field.settings.tlsReloadHour.help':
      'When a renewed certificate is put in place if the opening hours offer no closed period.',
    'field.settings.autoUpdate': 'Automatic updates',
    'field.settings.autoUpdate.help':
      'Installs new compatible versions after a backup, at a moment when nobody is on the phone.',
    'field.settings.mfaRequiredForAll': 'Second factor for everyone',
    'field.settings.mfaRequiredForAll.help':
      'Then every user needs a passkey or an authenticator app too.',
    'field.settings.ssoProvider': 'Provider',
    'field.settings.ssoLabel': 'Button text',
    'field.settings.ssoLabel.help': 'Required for OIDC.',
    'field.settings.ssoIssuer': 'Issuer URL',
    'field.settings.ssoIssuer.help':
      'Required for OIDC; preset for Microsoft and Google.',
    'field.settings.ssoClientId': 'Client ID',
    'field.settings.ssoClientId.help':
      'From the app registration at the provider.',
    'field.settings.ssoTenantId': 'Tenant ID (Entra)',
    'field.settings.ssoTenantId.help':
      "Your Microsoft Entra tenant ID, so only your company's accounts are accepted.",
    'field.settings.ssoAllowedDomain': 'Allowed domain',
    'field.settings.ssoAllowedDomain.help':
      'Only accounts of this e-mail domain may sign in.',
    'field.settings.ssoClientSecret': 'Client secret',
    'field.settings.ssoClientSecret.help':
      'Never shown again, only whether one is set.',
    'field.settings.ringotelMaxRegs': 'Devices per person',
    'field.settings.ringotelMaxRegs.help':
      "On how many devices a person may use the app at once; Ringotel setup takes the package's value.",
    'field.settings.ringotelApiToken': 'Ringotel API token',
    'field.settings.ringotelApiToken.help':
      'From the Ringotel Shell; never shown again.',

    'errors.settingsReadOnly': '{field} cannot be changed.',
    'errors.settingsMainDid': 'The main number must be an active phone number.',
    'errors.settingsCountry': 'Please choose a country with a calling code.',
    'errors.settingsTimezone': 'Unknown time zone.',
    'errors.settingsEmergencyDigits':
      'Please enter at least one emergency number, digits only.',
    'errors.settingsEmergencyExtension':
      'Already an extension, so it cannot be an emergency number: {list}',
    'errors.settingsCodecs': 'Please choose at least one codec.',
    'errors.settingsMohAudio':
      'Please choose hold music from the audio library.',
    'errors.settingsRetentionWindow':
      'Deleted entries ({softDelete} days) must not be kept longer than the audit log ({audit} days) – otherwise a deletion could no longer be undone.',
    'errors.settingsCron': 'Not a valid cron expression.',
    'errors.settingsSsoClientId':
      'With an SSO provider the client ID is required.',
    'errors.settingsSsoTenantId': 'Microsoft needs the tenant ID.',
    'errors.settingsSsoOidc': 'OIDC needs the issuer URL and the button text.',
    'errors.settingsFallbackExternal':
      'Please enter a number in international format.',
    'errors.featureCodeKeys': 'Please fill in all ten feature codes.',
    'errors.featureCodeStart': 'Must start with * or #.',
    'errors.featureCodeSame': '“{code}” is already used for another function.',
    'errors.featureCodePrefix':
      '“{code}” is the start of “{other}” – the phone could not tell them apart.',
    'errors.sipBanSteps': 'Invalid ban steps.',
    'errors.sipBanStepsRange':
      'Each ban lasts at least 1 minute and at most 100 years.',
    'errors.sipBanStepsIncreasing':
      'Each step must be longer than the one before.',
    'errors.sipBanStepsPermanentLast':
      'Permanent is only possible as the last step.',

    /* ---------- mail templates ---------- */
    'mailTemplates.subtitle':
      "The system's e-mails in every language. Your version replaces the built-in one.",
    'mailTemplates.kinds': 'E-mail kinds',
    'mailTemplates.kind.voicemail': 'New voicemail',
    'mailTemplates.kind.voicemail.help':
      'To the mailbox owners, with the recording attached.',
    'mailTemplates.kind.missedCall': 'Missed call',
    'mailTemplates.kind.missedCall.help':
      'To people who asked to hear about missed calls.',
    'mailTemplates.kind.setup': 'Invitation',
    'mailTemplates.kind.setup.help':
      'A new account: the link to set a password.',
    'mailTemplates.kind.reset': 'Password reset',
    'mailTemplates.kind.reset.help': 'The link to reset a password.',
    'mailTemplates.kind.updateFailed': 'Update failed',
    'mailTemplates.kind.updateFailed.help':
      'To the owners when an automatic update fails.',
    'mailTemplates.kind.breakingUpdate': 'Major update available',
    'mailTemplates.kind.breakingUpdate.help':
      'To the owners when a version must be installed by hand.',
    'mailTemplates.kind.mfaChanged': 'Sign-in security changed',
    'mailTemplates.kind.mfaChanged.help':
      'To the person whose second factor changed.',
    'mailTemplates.customised': 'Your version: {languages}',
    'mailTemplates.override': 'Your version',
    'mailTemplates.shipped': 'Built-in',
    'mailTemplates.tenantLanguage': 'System language',
    'mailTemplates.updatedAt': 'changed {at}',
    'mailTemplates.language': 'Language',
    'mailTemplates.htmlSwitch': 'Also send an HTML version',
    'mailTemplates.placeholders': 'Placeholders – click to insert',
    'mailTemplates.insert': 'Insert at the cursor',
    'mailTemplates.required': 'required',
    'mailTemplates.syntaxHint':
      'Allowed: {{name}}, {{date name}} for times, and conditions with {{#if name}} … {{else}} … {{/if}}.',
    'mailTemplates.unknown': 'Not available for this e-mail: {names}',
    'mailTemplates.missing': 'Must appear: {names}',
    'mailTemplates.revert': 'Revert to built-in version',
    'mailTemplates.test': 'Send me a test',
    'mailTemplates.testSaveFirst':
      'Save first – the test sends the saved version.',
    'mailTemplates.test.sent': 'Test e-mail ({language}) sent to {email}',
    'mailTemplates.test.skipped':
      'Not sent: no mail server set up, or no e-mail address',
    'mailTemplates.test.failed':
      'The mail server did not accept the test e-mail',
    'mailTemplates.otherLanguage':
      'E-mails go out in the system language ({language}); this version applies once the language is switched.',
    'mailTemplates.preview': 'Preview',
    'mailTemplates.previewBody': 'With example values, as the e-mail arrives.',
    'mailTemplates.previewText': 'Text',
    'mailTemplates.previewHtml': 'HTML',
    'mailTemplates.from': 'From:',
    'mailTemplates.to': 'To:',
    'mailTemplates.sampleNote':
      'The test e-mail uses the saved version with example values.',
    'mailTemplates.saved': '{kind} ({language}) saved',
    'mailTemplates.reverted': 'The built-in version applies again',
    'confirm.mailTemplates.delete.title': 'Delete your version?',
    'confirm.mailTemplates.delete.body':
      'Your version ({language}) is deleted; the built-in text applies again.',
    'confirm.mailTemplates.delete.action': 'Revert',
    'field.mailTemplate.subject': 'Subject',
    'field.mailTemplate.bodyText': 'Text',
    'field.mailTemplate.bodyText.help':
      'The plain-text version every mail program shows.',
    'field.mailTemplate.bodyHtml': 'HTML version',
    'field.mailTemplate.bodyHtml.help':
      'Optional. Placeholder values are inserted safely.',
    'errors.templateUnknownPlaceholder':
      'This e-mail has no placeholder {{{name}}}.',
    'errors.templateMissingRequired': 'The placeholder {{{name}}} must appear.',
    'errors.templateSyntax': 'The template contains an error: {message}',
    'errors.mailTemplateNoOverride': 'There is no custom version.',

    /* ---------- integrations ---------- */
    'integrations.subtitle':
      'Connect AI assistants, webhooks and the REST API.',
    'integrations.mcp.title': 'Connect an AI assistant',
    'integrations.mcp.body':
      'Claude, Codex and other MCP-capable assistants operate the phone system by chat – with your permissions.',
    'integrations.mcp.other': 'Other assistants (MCP URL)',
    'integrations.mcp.step1': 'Run the command',
    'integrations.mcp.step1Body':
      "In a terminal, or add the MCP URL in your assistant's settings.",
    'integrations.mcp.step2': 'Sign in in the browser',
    'integrations.mcp.step2Body':
      "The assistant opens the phone system's sign-in. You sign in and allow access.",
    'integrations.mcp.step3': 'Get going',
    'integrations.mcp.step3Body':
      "The assistant can do exactly what your role allows. Every change is in the audit log, with the assistant's name.",
    'integrations.mcp.mucki':
      'Mucki, the assistant built in here, works the same way: with your permissions, every change logged.',
    'integrations.webhooks.title': 'Webhooks',
    'integrations.webhooks.body':
      'The system sends events to your systems, such as a CRM. Every delivery is signed with the secret.',
    'integrations.webhooks.empty': 'No webhooks yet',
    'integrations.webhooks.emptyBody':
      'Let your CRM know when a call rings or a voicemail arrives.',
    'integrations.webhook.add': 'Add webhook',
    'integrations.webhook.edit': 'Edit webhook',
    'integrations.webhook.createdInactive':
      'New webhooks start switched off – switch it on once your system is ready to receive.',
    'integrations.webhook.delivery': 'Delivery',
    'integrations.webhook.allEvents': 'All events',
    'integrations.webhook.allEventsHelp': 'Including event types added later.',
    'integrations.webhook.inactive': 'Switched off',
    'integrations.webhook.ok': 'Delivering',
    'integrations.webhook.noDelivery': 'Nothing delivered yet',
    'integrations.webhook.lastDelivery': 'last {at}',
    'integrations.webhook.lastError': 'Last error {at}: {error}',
    'integrations.webhook.failingSince': 'Failing since {since}',
    'integrations.webhook.failedCount': '{count} deliveries failed',
    'integrations.webhook.generate': 'Generate',
    'integrations.webhook.activeSwitch': 'Deliver events',
    'integrations.webhook.created': 'Webhook added – still switched off',
    'integrations.webhook.saved': 'Webhook saved',
    'integrations.webhook.deleted': 'Webhook deleted',
    'integrations.webhook.activated': 'Webhook switched on',
    'integrations.webhook.deactivated': 'Webhook switched off',
    'integrations.event.presence': 'Presence',
    'integrations.event.call.state': 'Call state',
    'integrations.event.voicemail.new': 'New voicemail',
    'integrations.event.ooo': 'Out of office',
    'integrations.event.hours': 'Opening hours',
    'integrations.event.trunk.status': 'Trunk status',
    'integrations.event.sipBan.added': 'SIP ban',
    'integrations.event.history.appended': 'Call history',
    'integrations.event.backup.started': 'Backup started',
    'integrations.event.backup.finished': 'Backup finished',
    'integrations.event.backup.failed': 'Backup failed',
    'integrations.tokens.title': 'Access tokens',
    'integrations.tokens.body':
      'For your own scripts and programs that use the REST API with your permissions.',
    'integrations.tokens.open': 'My access tokens',
    'integrations.rest.title': 'REST API',
    'integrations.rest.body':
      'Everything you can do here and through an AI assistant – described as OpenAPI 3.1.',
    'integrations.rest.openapi': 'OpenAPI document',
    'integrations.rest.base': 'Base URL',
    'integrations.rest.auth':
      'Authenticate with the header “Authorization: Bearer <access token>”. Actions that ask for confirmation expect “confirm: true”.',
    'confirm.webhooks.delete.title': 'Delete the webhook?',
    'confirm.webhooks.delete.body':
      'No more events go to {url}; deliveries still pending are dropped.',
    'confirm.webhooks.delete.action': 'Delete',
    'field.webhook.url': 'URL',
    'field.webhook.url.help':
      'Every event is POSTed as JSON to this http(s) address.',
    'field.webhook.secret': 'Secret',
    'field.webhook.secret.help':
      'Each delivery carries X-Zamfono-Signature, the HMAC-SHA256 of the body under this secret. Never shown again.',
    'field.webhook.eventTypes': 'Events',
    'field.webhook.active': 'Active',
    'errors.webhookUrl': 'Please enter an http or https address.',
    'errors.webhookSecret': 'A secret is required.',
    'errors.webhookEventTypes': 'Unknown event type.',

    /* ---------- backups ---------- */
    'backups.subtitle':
      'Encrypted backups of the phone system with every setting, recording and message.',
    'backups.schedule.title': 'Schedule',
    'backups.schedule.change': 'Change',
    'backups.schedule.when': 'Runs',
    'backups.schedule.next': 'Next backup',
    'backups.schedule.lastGood': 'Last successful',
    'backups.schedule.never': 'never',
    'backups.schedule.hint':
      'Each backup goes to every enabled target. An update needs a successful backup from the last hour.',
    'backups.targets.empty': 'No backup target yet',
    'backups.targets.emptyBody': 'Add at least one target, ideally off-site.',
    'backups.target.add': 'Add target',
    'backups.target.edit': 'Edit target',
    'backups.target.drawerBody':
      'Encrypted and versioned; unchanged data is stored only once.',
    'backups.target.disabled': 'Paused',
    'backups.target.lastRun': 'Last run',
    'backups.target.size': 'Size',
    'backups.target.keeps': 'Keeps',
    'backups.target.scheduled': 'Back up on schedule',
    'backups.target.created': 'Backup target added',
    'backups.target.saved': 'Backup target saved',
    'backups.target.deleted': 'Backup target deleted',
    'backups.target.enabledToast': 'Target backed up on schedule again',
    'backups.target.disabledToast': 'Target paused',
    'backups.deletedTarget': 'Deleted target',
    'backups.run.now': 'Back up now',
    'backups.run.started': 'Backup running: {target}',
    'backups.forget.title': 'Retention',
    'backups.forget.help':
      'How many daily, weekly and monthly snapshots are kept; 7 / 4 / 6 by default.',
    'backups.forget.keepDaily': 'Days',
    'backups.forget.keepWeekly': 'Weeks',
    'backups.forget.keepMonthly': 'Months',
    'backups.forget.summary':
      '{keepDaily} d · {keepWeekly} w · {keepMonthly} m',
    'backups.kind.local': 'Local',
    'backups.kind.local.help':
      'A directory or volume on the server itself. Protects against mistakes, not against losing the server.',
    'backups.kind.ftp': 'FTP',
    'backups.kind.ftp.help':
      'An FTP server, such as a NAS. Unencrypted transfer – prefer FTPS or SFTP.',
    'backups.kind.ftps': 'FTPS',
    'backups.kind.ftps.help': 'An FTP server with TLS.',
    'backups.kind.sftp': 'SFTP',
    'backups.kind.sftp.help':
      'A server with SSH access, such as a NAS in the office.',
    'backups.kind.s3': 'S3',
    'backups.kind.s3.help':
      'S3-compatible object storage (AWS, Wasabi, Hetzner, MinIO …).',
    'backups.kind.webdav': 'WebDAV',
    'backups.kind.webdav.help': 'WebDAV storage, such as Nextcloud.',
    'backups.param.path': 'Path',
    'backups.param.endpoint': 'Endpoint',
    'backups.param.bucket': 'Bucket',
    'backups.param.host': 'Server',
    'backups.param.url': 'URL',
    'backups.param.path.placeholder.local': '/backups/restic',
    'backups.param.path.placeholder.s3': 'zamfono',
    'backups.param.path.placeholder.sftp': '/volume1/backup/zamfono',
    'backups.param.path.placeholder.ftp': '/backup/zamfono',
    'backups.param.path.placeholder.ftps': '/backup/zamfono',
    'backups.param.path.placeholder.webdav': 'zamfono',
    'backups.param.endpoint.placeholder.s3': 's3.eu-central-1.amazonaws.com',
    'backups.param.bucket.placeholder.s3': 'company-phone-system',
    'backups.param.host.placeholder.sftp': 'nas.example.com',
    'backups.param.host.placeholder.ftp': 'nas.example.com',
    'backups.param.host.placeholder.ftps': 'nas.example.com',
    'backups.param.url.placeholder.webdav':
      'https://cloud.example.com/remote.php/dav/files/backup',
    'backups.secret.resticPassword': 'Backup password',
    'backups.secret.resticPasswordHelp':
      'Encrypts the backup. Keep a copy somewhere safe – without it nothing can be restored.',
    'backups.secret.username': 'User name',
    'backups.secret.password': 'Password',
    'backups.secret.accessKeyId': 'Access key ID',
    'backups.secret.secretAccessKey': 'Secret access key',
    'backups.secret.change': 'Change credentials',
    'backups.secret.replaceHelp':
      'The credentials are always replaced as a whole.',
    'backups.status.running': 'Running',
    'backups.status.ok': 'Succeeded',
    'backups.status.failed': 'Failed',
    'backups.status.failedAt': 'Failed {at}',
    'backups.runs.title': 'History',
    'backups.runs.allTargets': 'All targets',
    'backups.runs.started': 'Started',
    'backups.runs.target': 'Target',
    'backups.runs.duration': 'Duration',
    'backups.runs.added': 'Added',
    'backups.runs.total': 'Total',
    'backups.runs.snapshot': 'Snapshot',
    'backups.runs.empty': 'No backups have run yet',
    'confirm.backups.targets.delete.title': 'Delete the backup target?',
    'confirm.backups.targets.delete.body':
      'Nothing more is backed up to {kind} {location}. Existing backups there are kept.',
    'confirm.backups.targets.delete.action': 'Delete',
    'field.backupTarget.kind': 'Kind',
    'field.backupTarget.params': 'Location',
    'field.backupTarget.secret': 'Credentials',
    'field.backupTarget.secret.help': 'Stored encrypted and never shown again.',
    'field.backupTarget.enabled': 'Active',
    'errors.backupHost':
      'Please enter a server name (FQDN) or an IPv4 address.',
    'errors.backupWebdavUrl': 'Please enter an http or https address.',
    'errors.backupSecretKind':
      'This type needs exactly these credentials: {fields}.',
    'errors.backupSftpUsername':
      'The user name cannot start with - or contain spaces, quotes or backslashes.',

    /* ---------- audit ---------- */
    'audit.subtitle':
      'Every change, who made it and how – with Undo where possible.',
    'audit.filter.state': 'State',
    'audit.filter.kind': 'Area',
    'audit.filter.actor': 'Who',
    'audit.filter.operation': 'What',
    'audit.filter.from': 'From',
    'audit.filter.to': 'To',
    'audit.filter.channel': 'Channel',
    'audit.filter.client': 'Application',
    'audit.filter.anyKind': 'All areas',
    'audit.filter.anyone': 'Anyone',
    'audit.filter.anyOperation': 'All changes',
    'audit.filter.anyChannel': 'All channels',
    'audit.filter.anyClient': 'All applications',
    'audit.filter.reset': 'Reset filters',
    'audit.state.live': 'Current',
    'audit.state.undone': 'Undone',
    'audit.state.all': 'All',
    'audit.channel.ui': 'Web app',
    'audit.channel.mcp': 'AI assistant',
    'audit.channel.rest': 'REST API',
    'audit.channel.undo': 'Undo',
    'audit.channel.job': 'Automatic',
    'audit.empty': 'No entries',
    'audit.emptyFiltered': 'No entry matches the filters.',
    'audit.emptyList': 'empty',
    'audit.more': 'Show {count} more',
    'audit.notUndoable': 'cannot be undone',
    'audit.undoneBadge': 'Undone {at}',
    'audit.reverts': 'undoes: {what}',
    'audit.verb.create': '{kind} created',
    'audit.verb.update': '{kind} changed',
    'audit.verb.delete': '{kind} deleted',
    'audit.verb.other': '{operation}',
    'audit.kind.user': 'User',
    'audit.kind.device': 'Device',
    'audit.kind.ringGroup': 'Ring group',
    'audit.kind.userGroup': 'User group',
    'audit.kind.menu': 'Phone menu',
    'audit.kind.did': 'Number',
    'audit.kind.didBlock': 'Number block',
    'audit.kind.trunk': 'SIP trunk',
    'audit.kind.webhook': 'Webhook',
    'audit.kind.contact': 'Contact',
    'audit.kind.audio': 'Audio file',
    'audit.kind.oooRule': 'Out of office',
    'audit.kind.openingHours': 'Opening hours',
    'audit.kind.backupTarget': 'Backup target',
    'audit.kind.backupRun': 'Backup',
    'audit.kind.blockedNumber': 'Blocked number',
    'audit.kind.sipAllowlistEntry': 'SIP allowlist entry',
    'audit.kind.sipBan': 'SIP ban',
    'audit.kind.settings': 'Settings',
    'audit.kind.outboundRoute': 'Outbound routes',
    'audit.kind.parking': 'Parking slots',
    'audit.kind.personalAccessToken': 'Access token',
    'audit.kind.mailTemplate': 'Mail template',
    'audit.kind.system': 'System',
    'audit.kind.voicemail': 'Voicemail',
    'audit.kind.recording': 'Recording',
    'audit.op.users.create': 'Created a user',
    'audit.op.users.update': 'Changed a user',
    'audit.op.users.delete': 'Deleted a user',
    'audit.op.users.resetPassword': 'Sent a password link',
    'audit.op.users.resetMfa': 'Reset two-factor sign-in',
    'audit.op.users.erase': "Erased a user's data for good",
    'audit.op.users.setForwarding': 'Changed forwarding',
    'audit.op.devices.create': 'Added a device',
    'audit.op.devices.update': 'Changed a device',
    'audit.op.devices.delete': 'Removed a device',
    'audit.op.devices.rotate': 'Renewed a device password',
    'audit.op.devices.revealCredentials': "Revealed a device's credentials",
    'audit.op.devices.setBlf': 'Changed the key panel',
    'audit.op.personalAccessTokens.create': 'Created an access token',
    'audit.op.personalAccessTokens.revoke': 'Revoked an access token',
    'audit.op.provisioning.ringotelSetup': 'Set up Ringotel',
    'audit.op.provisioning.ringotelAdopt': 'Adopted a Ringotel organization',
    'audit.op.trunks.create': 'Added a SIP trunk',
    'audit.op.trunks.update': 'Changed a SIP trunk',
    'audit.op.trunks.delete': 'Deleted a SIP trunk',
    'audit.op.trunks.setOrder': 'Changed the emergency trunk order',
    'audit.op.trunks.reregister': 'Re-registered a trunk',
    'audit.op.outboundRoutes.replace': 'Changed the outbound routes',
    'audit.op.dids.create': 'Added a number',
    'audit.op.dids.update': 'Changed a number',
    'audit.op.dids.delete': 'Deleted a number',
    'audit.op.didBlocks.create': 'Added a number block',
    'audit.op.didBlocks.update': 'Changed a number block',
    'audit.op.didBlocks.delete': 'Deleted a number block',
    'audit.op.ringGroups.create': 'Created a ring group',
    'audit.op.ringGroups.update': 'Changed a ring group',
    'audit.op.ringGroups.delete': 'Deleted a ring group',
    'audit.op.ringGroups.setForwarding': "Changed a ring group's forwarding",
    'audit.op.userGroups.create': 'Created a user group',
    'audit.op.userGroups.update': 'Changed a user group',
    'audit.op.userGroups.delete': 'Deleted a user group',
    'audit.op.audio.create': 'Uploaded an audio file',
    'audit.op.audio.update': 'Changed an audio file',
    'audit.op.audio.delete': 'Deleted an audio file',
    'audit.op.voicemails.delete': 'Deleted a voicemail',
    'audit.op.recordings.delete': 'Deleted a recording',
    'audit.op.contacts.create': 'Added a contact',
    'audit.op.contacts.update': 'Changed a contact',
    'audit.op.contacts.delete': 'Deleted a contact',
    'audit.op.blockedNumbers.create': 'Blocked a number',
    'audit.op.blockedNumbers.delete': 'Lifted a number block',
    'audit.op.sipBans.ban': 'Banned an address for failed attempts',
    'audit.op.sipBans.lift': 'Lifted a SIP ban',
    'audit.op.sipAllowlist.create': 'Allowed an address for SIP',
    'audit.op.sipAllowlist.delete': 'Removed a SIP allowlist entry',
    'audit.op.parking.set': 'Changed the parking slots',
    'audit.op.menus.create': 'Created a phone menu',
    'audit.op.menus.update': 'Changed a phone menu',
    'audit.op.menus.delete': 'Deleted a phone menu',
    'audit.op.menus.setTargets': "Changed a phone menu's keys",
    'audit.op.ooo.create': 'Added an out-of-office period',
    'audit.op.ooo.update': 'Changed an out-of-office period',
    'audit.op.ooo.delete': 'Deleted an out-of-office period',
    'audit.op.hours.set': 'Changed opening hours',
    'audit.op.hours.delete': 'Removed opening hours',
    'audit.op.webhooks.create': 'Added a webhook',
    'audit.op.webhooks.update': 'Changed a webhook',
    'audit.op.webhooks.delete': 'Deleted a webhook',
    'audit.op.mailTemplates.put': 'Customised a mail template',
    'audit.op.mailTemplates.delete': 'Reverted a mail template',
    'audit.op.mailTemplates.test': 'Sent a test e-mail',
    'audit.op.backups.targets.create': 'Added a backup target',
    'audit.op.backups.targets.update': 'Changed a backup target',
    'audit.op.backups.targets.delete': 'Deleted a backup target',
    'audit.op.backups.runs.start': 'Started a backup by hand',
    'audit.op.settings.update': 'Changed settings',
    'audit.op.system.update': 'Started an update',
    'audit.op.system.autoUpdate': 'Automatic update',
    'audit.op.system.maintenanceGate': 'Maintenance postponed',
    'audit.op.audit.undo': 'Undid a change',
    'audit.op.ringotel.push': 'Sent a device to Ringotel',
    'audit.op.ringotel.profile': 'Sent the profile to Ringotel',
    'audit.op.ringotel.roster': 'Sent the colleague list to Ringotel',
    'audit.op.ringotel.rereg': 'Re-registered the Ringotel apps',
    'errors.undoNoEntity':
      'This change does not affect a single entry, so it cannot be undone.',
    'errors.undoPurged': 'The entry has since been deleted for good:',

    /* ---------- system & updates ---------- */
    'system.subtitle': 'Versions, updates and the health of the phone system.',
    'system.check.now': 'Check for updates',
    'system.check.available': 'Version {version} is available',
    'system.check.current': 'The phone system is up to date',
    'system.update.title': 'Update',
    'system.update.available':
      'New version – you are on {current}. Released {date}.',
    'system.update.notes': "What's new?",
    'system.update.backupOk': 'Backup in place ({at}) – ready to update.',
    'system.update.backupNeeded':
      'An update needs a successful backup from the last hour (last: {at}).',
    'system.update.backupRunning':
      'Backup running – the update can start afterwards.',
    'system.update.toBackups': 'Go to backups',
    'system.update.now': 'Update now',
    'system.update.ownerOnly': 'Owners install updates.',
    'system.update.breaking':
      'Version {version} contains major changes and must be installed on the server with update.sh.',
    'system.update.upToDate': 'Up to date ({version})',
    'system.update.last': 'Last update',
    'system.update.never': 'None yet',
    'system.update.lastLine': '{from} → {to}',
    'system.update.state.running': 'Running',
    'system.update.state.succeeded': 'Succeeded',
    'system.update.state.failed': 'Failed',
    'system.update.trigger.manual': 'Started by {by}',
    'system.update.trigger.automatic': 'Automatic',
    'system.update.trigger.host': 'On the server',
    'system.update.started': 'Update started – the system restarts shortly',
    'system.maintenance.title': 'Updating to {version}',
    'system.maintenance.body':
      'Calls in progress drop while the system restarts. This usually takes a minute or two.',
    'system.versions.title': 'Versions',
    'system.versions.api': 'API',
    'system.versions.core': 'Telephony core',
    'system.versions.coreDown': 'not answering',
    'system.versions.apiStarted': 'Running since',
    'system.versions.asteriskStarted': 'Telephony core running since',
    'system.stack.domain': 'Address',
    'system.stack.ipv4': 'Public IPv4',
    'system.auto.title': 'Automatic updates',
    'system.auto.onBody':
      'New compatible versions arrive on their own, after a backup.',
    'system.auto.offBody': 'Updates are installed by hand.',
    'system.auto.failed':
      'The last automatic update failed after {attempts} attempts: {error}',
    'system.goSettings': 'Settings',
    'system.mail.title': 'Mail server',
    'system.mail.none': 'Not set up',
    'system.mail.ok': 'Reachable',
    'system.relayError.unreachable': 'unreachable',
    'system.relayError.tls': 'TLS error',
    'system.relayError.authentication': 'sign-in refused',
    'system.relayError.rejected': 'e-mail rejected',
    'system.ringotel.title': 'Ringotel',
    'system.ringotel.inSync': 'Up to date',
    'system.ringotel.pending': 'Waiting to send',
    'system.ringotel.profile': 'profile',
    'system.ringotel.roster': 'colleague list',
    'system.ringotel.body':
      'Changes to codecs, feature codes and people reach the apps automatically.',
    'system.skipped.title': 'Skipped configuration',
    'system.skipped.body':
      'Entries left out of the latest configuration because the telephony core cannot process one of their values.',
    'system.skipped.none': 'None – everything was applied',
    'system.skipped.type': 'Type',
    'system.skipped.field': 'Field',
    'system.unit.1': 'seconds',
    'system.unit.60': 'minutes',
    'system.unit.3600': 'hours',
    'system.unit.86400': 'days',
    'system.cron.daily': 'Daily at {time}',
    'system.cron.weekly': 'Every {days} at {time}',
    'system.cron.monthly': 'Monthly on day {day} at {time}',
    'system.cron.everyHours': 'Every {hours} hours, at minute {minute}',
    'system.cron.custom': 'Custom schedule',
    'system.cron.next': 'Next: {runs}',
    'system.cron.invalid':
      'Not a valid cron expression (minute hour day month weekday).',
    'system.weekday.mon': 'Monday',
    'system.weekday.tue': 'Tuesday',
    'system.weekday.wed': 'Wednesday',
    'system.weekday.thu': 'Thursday',
    'system.weekday.fri': 'Friday',
    'system.weekday.sat': 'Saturday',
    'system.weekday.sun': 'Sunday',
    'confirm.system.update.title': 'Update to {version}?',
    'confirm.system.update.body':
      'Calls in progress drop while the system restarts. The update can only be reversed by restoring the backup.',
    'confirm.system.update.action': 'Update now',
    'field.systemUpdate.version': 'Target version',
    'field.systemUpdate.version.help': 'Empty: the latest version.',
    'errors.updateNeedsBackup':
      'Back up first: an update needs a successful backup from the last hour.',
    'errors.updateRunning': 'An update is already running.',
    'errors.updateNothingNewer':
      'There is no newer version that can be installed here.',
    'errors.updateVersionFormat': 'Please enter a version in the format 0.5.0.',
    'errors.updateVersionUnknown': 'There is no version {version}.',

    /* ---------- ringotel ---------- */
    'ringotel.subtitle':
      'Connects the phone system to Ringotel, so the smartphone and desktop app sets itself up.',
    'ringotel.what.title': 'What happens?',
    'ringotel.what.point1':
      'The system creates an organization at Ringotel and a connection to itself.',
    'ringotel.what.point2':
      'Everyone with an app device gets a Ringotel account and an invitation automatically.',
    'ringotel.what.point3':
      'Feature codes, codecs, language and the colleague list are kept in sync with the app.',
    'ringotel.status.title': 'Status',
    'ringotel.status.connected': 'Connected',
    'ringotel.status.connectedBody': 'App devices are set up automatically.',
    'ringotel.status.notConnected': 'Not connected yet',
    'ringotel.status.notConnectedBody': 'Set up Ringotel below.',
    'ringotel.status.org': 'Organization',
    'ringotel.status.branch': 'Connection',
    'ringotel.status.noToken': 'missing',
    'ringotel.status.sync': 'Sync',
    'ringotel.toSettings': 'Token & devices per person',
    'ringotel.setup.title': 'Set up',
    'ringotel.setup.titleConnected': 'Set up or adopt',
    'ringotel.setup.body':
      'Create a new organization, or adopt an existing empty one.',
    'ringotel.setup.connectedBody':
      'Only for a system not yet connected – this one already is.',
    'ringotel.setup.show': 'Show',
    'ringotel.setup.hide': 'Hide',
    'ringotel.setup.needsToken':
      'Add the Ringotel API token in the settings first.',
    'ringotel.setup.new': 'New organization',
    'ringotel.setup.adopt': 'Adopt existing',
    'ringotel.setup.newBody':
      'Creates the organization under your company name. The region cannot be changed afterwards.',
    'ringotel.setup.adoptBody':
      'For an organization created in the Ringotel Shell. It must not have users yet.',
    'ringotel.setup.branchPlaceholder': 'empty: create a new connection',
    'ringotel.setup.create': 'Create organization',
    'ringotel.setup.adoptAction': 'Adopt',
    'ringotel.setup.expert':
      'Ringotel domain, region and package are then managed at Ringotel; the system keeps the organization and connection IDs.',
    'ringotel.package': '{name} ({regs} devices per person)',
    'ringotel.connectedToast': 'Ringotel set up',
    'ringotel.adoptedToast': 'Ringotel organization adopted',
    'confirm.provisioning.ringotelAdopt.title': 'Adopt the organization?',
    'confirm.provisioning.ringotelAdopt.body':
      'The Ringotel organization {domain} gets a new connection to this system.',
    'confirm.provisioning.ringotelAdopt.action': 'Adopt',
    'confirm.provisioning.ringotelAdoptBranch.title': 'Adopt the organization?',
    'confirm.provisioning.ringotelAdoptBranch.body':
      'Connection {branchId} of the Ringotel organization {domain} is pointed at this system.',
    'confirm.provisioning.ringotelAdoptBranch.action': 'Adopt',
    'field.ringotel.domain': 'Ringotel domain',
    'field.ringotel.domain.help':
      'Unique across Ringotel, such as the company name without spaces.',
    'field.ringotel.region': 'Region',
    'field.ringotel.region.help':
      'Where the data lives; cannot be changed later.',
    'field.ringotel.packageid': 'Package',
    'field.ringotel.orgId': 'Organization ID',
    'field.ringotel.orgId.help':
      'Shown with the organization in the Ringotel Shell.',
    'field.ringotel.branchId': 'Connection ID',
    'field.ringotel.branchId.help': 'Optional: reuse an existing connection.',
    'errors.ringotelAlreadySetUp':
      'Ringotel is already set up (organization {orgId}).',
    'errors.ringotelNoToken':
      'Add the Ringotel API token in the settings first.',
    'errors.ringotelRegion': 'Ringotel does not offer this region: {list}.',
    'errors.ringotelPackage': 'Ringotel does not offer this package: {list}.',
    'errors.ringotelDomainTaken':
      'An organization {domain} already exists (ID {orgId}). If it belongs to this system, adopt it.',
    'errors.ringotelOrgHasUsers':
      'The organization already has {users} users; only an empty one is adopted.',

    /* ---------- SIP protection ---------- */
    'sipProtection.subtitle':
      'Addresses that try too often to sign in with wrong credentials are banned.',
    'sipProtection.activeCount': '{count} active bans',
    'sipProtection.bans.title': 'Bans',
    'sipProtection.bans.body':
      'Banned addresses no longer reach the SIP ports; the web app stays reachable.',
    'sipProtection.bans.active': 'Active',
    'sipProtection.bans.ended': 'Ended',
    'sipProtection.bans.address': 'Address',
    'sipProtection.bans.step': 'Step',
    'sipProtection.bans.stepN': 'Ban no. {n}',
    'sipProtection.bans.failures': 'Failed attempts',
    'sipProtection.bans.since': 'Since',
    'sipProtection.bans.until': 'Until',
    'sipProtection.bans.permanent': 'Permanent',
    'sipProtection.bans.expires': 'ends {at}',
    'sipProtection.bans.expired': 'expired {at}',
    'sipProtection.bans.liftedBy': 'lifted {at} by {by}',
    'sipProtection.bans.lift': 'Lift',
    'sipProtection.bans.lifted': 'Ban of {address} lifted',
    'sipProtection.bans.emptyActive': 'No active bans',
    'sipProtection.bans.empty': 'No bans',
    'sipProtection.allow.title': 'Allowlist',
    'sipProtection.allow.body':
      'These addresses and networks are never banned, such as your office. A new entry ends matching bans at once.',
    'sipProtection.allow.add': 'Allow',
    'sipProtection.allow.added': '{address} allowed',
    'sipProtection.allow.deleted': 'Allowlist entry removed',
    'sipProtection.allow.labelPlaceholder': 'e.g. Munich office',
    'sipProtection.allow.empty': 'No entries yet.',
    'sipProtection.rules.title': 'Ban rules',
    'sipProtection.rules.summary':
      '{failures} failed attempts within {window} ban an address: {steps}.',
    'sipProtection.rules.off': 'Banning is switched off.',
    'sipProtection.steps.on': 'Ban addresses',
    'sipProtection.steps.offHelp':
      'When off, no new bans are imposed and existing ones are no longer enforced.',
    'sipProtection.steps.nth': 'Ban no. {n}',
    'sipProtection.steps.permanent': 'permanent',
    'sipProtection.steps.permanentShort': 'permanent',
    'sipProtection.steps.add': 'Add step',
    'sipProtection.steps.lastPermanent': 'Last step permanent',
    'confirm.sipBans.lift.title': 'Lift the ban?',
    'confirm.sipBans.lift.body':
      '{address} reaches the SIP ports again at once. If failed attempts pile up again, it is banned again.',
    'confirm.sipBans.lift.action': 'Lift',
    'confirm.sipAllowlist.delete.title': 'Remove from the allowlist?',
    'confirm.sipAllowlist.delete.body':
      '{address} can be banned again afterwards.',
    'confirm.sipAllowlist.delete.action': 'Remove',
    'field.sipAllowlistEntry.address': 'Address or network',
    'field.sipAllowlistEntry.address.help':
      'An IP address or a CIDR range, IPv4 or IPv6, such as 198.51.100.0/24.',
    'field.sipAllowlistEntry.label': 'Note',
    'errors.sipAllowlistAddress':
      'Please enter an IP address or a network like 198.51.100.0/24.',
    'errors.sipBanEnded': 'This ban has already ended.'
  }
} satisfies Messages;
