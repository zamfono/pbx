/**
 * People and self-service: users, user groups, devices, access tokens and "My settings"
 * (`people.*`), their fields, confirmations and refusals (`errors.people.*`).
 */
import type { Messages } from '../index.svelte';

export default {
  de: {
    'people.ext': 'Durchwahl {ext}',
    'people.phoneOnly': 'nur Telefon',
    'people.noExtension': 'keine Durchwahl',
    'people.discard': 'Verwerfen',
    'people.unsaved': 'Ungespeicherte Änderungen',
    'people.done': 'Fertig',
    'people.secondsShort': 's',
    'people.inherit': 'Standard ({value})',
    'people.mfa': 'Zwei-Faktor',
    'people.mfa.on': 'aktiv',
    'people.mfa.off': 'nicht eingerichtet',

    'people.tab.profile': 'Profil',
    'people.tab.devices': 'Geräte',
    'people.tab.forwarding': 'Weiterleitung',
    'people.tab.schedule': 'Abwesenheit & Zeiten',
    'people.tab.tokens': 'Zugriffstoken',
    'people.tab.greeting': 'Mailbox-Ansage',
    'people.tab.security': 'Sicherheit',

    'people.users.subtitle':
      'Alle Personen mit Durchwahl, Anmeldung und Geräten.',
    'people.users.add': 'Person anlegen',
    'people.users.addIntro':
      'Mit E-Mail bekommt die Person einen Link, um ihr Passwort zu setzen. Ohne E-Mail ist sie nur telefonisch erreichbar.',
    'people.users.search': 'Name, Durchwahl oder E-Mail',
    'people.users.empty': 'Niemand gefunden',
    'people.users.emptyBody':
      'Passen Sie die Suche an oder legen Sie eine Person an.',
    'people.users.notFound': 'Person nicht gefunden',
    'people.users.notFoundBody':
      'Diese Person wurde gelöscht oder existiert nicht.',
    'people.users.emailPlaceholder': 'leer lassen: nur Telefon',
    'people.users.namePlaceholder': 'z. B. Anna Beispiel',
    'people.users.phoneOnlyNote':
      'Ohne E-Mail kann sich die Person nicht anmelden; sie braucht dann eine Durchwahl.',
    'people.users.created': '{name} angelegt',
    'people.users.setupLink': 'Link zum Setzen des Passworts',
    'people.users.setupLinkNote':
      'Nur jetzt sichtbar. Er wurde auch per E-Mail verschickt und gilt 7 Tage.',
    'people.users.noSetupLink':
      'Ohne E-Mail gibt es keine Anmeldung und keinen Link.',
    'people.users.ringotelTitle': 'Ringotel-App für das Handy',
    'people.users.ringotelBody':
      'Richten Sie gleich die App ein; die Zugangsdaten gehen automatisch an Ringotel.',
    'people.users.ringotelDone': 'Die App ist eingerichtet.',
    'people.users.addAnother': 'Weitere Person',
    'people.users.openProfile': 'Zum Profil',
    'people.users.resetPassword': 'Passwort-Link senden',
    'people.users.resetSent': 'Neuer Passwort-Link für {name}',
    'people.users.resetTitle': 'Passwort-Link für {name}',
    'people.users.resetIntro':
      'Die Person setzt damit ein neues Passwort. Der Link ging auch per E-Mail an sie.',
    'people.users.resetMfa': 'Zwei-Faktor-Anmeldung zurücksetzen',
    'people.users.mfaReset': 'Zwei-Faktor-Anmeldung von {name} zurückgesetzt',
    'people.users.delete': 'Person löschen',
    'people.users.deleted': '{name} gelöscht',
    'people.users.erase': 'Personendaten löschen (DSGVO)',
    'people.users.erased': 'Personendaten gelöscht',
    'people.users.locked': 'Anmeldung gesperrt bis {until}',

    'people.profile.person': 'Person',
    'people.profile.calls': 'Anrufe',
    'people.profile.mailbox': 'Mailbox & Benachrichtigungen',
    'people.profile.saved': 'Gespeichert',
    'people.callerId.main': 'Hauptnummer ({number})',
    'people.clir.on': 'Nummer unterdrücken',
    'people.clir.off': 'Nummer anzeigen',
    'people.reject.on': 'Anonyme abweisen',
    'people.reject.off': 'Anonyme annehmen',
    'people.recordCalls.switch': 'Alle Gespräche dieser Person aufzeichnen',
    'people.recordCalls.on': 'Gespräche werden aufgezeichnet',
    'people.recordCalls.off': 'Keine Aufzeichnung',
    'people.mailbox.switch': 'Mailbox nimmt Nachrichten an',
    'people.notify.switch': 'E-Mail bei jedem verpassten Anruf',
    'people.greeting.default': 'Standardansage',

    'people.findMe.legs': 'Zusätzliche Nummern',
    'people.findMe.empty':
      'Keine zusätzlichen Nummern. Anrufe klingeln nur auf Ihren Geräten.',
    'people.findMe.add': 'Nummer hinzufügen',
    'people.findMe.after': 'nach',
    'people.findMe.immediately': 'sofort',
    'people.findMe.afterSeconds': 'nach {s} s',

    'people.forwarding.unconditional': 'Immer',
    'people.forwarding.unconditional.help':
      'Jeder Anruf wird sofort weitergeleitet.',
    'people.forwarding.busy': 'Wenn besetzt',
    'people.forwarding.busy.help': 'Alle Ihre Geräte sind im Gespräch.',
    'people.forwarding.noAnswer': 'Wenn niemand abnimmt',
    'people.forwarding.noAnswer.help': 'Nach Ablauf der Klingeldauer.',
    'people.forwarding.dnd': 'Bei „Nicht stören“',
    'people.forwarding.dnd.help': 'Solange „Nicht stören“ eingeschaltet ist.',
    'people.forwarding.offline': 'Wenn nicht erreichbar',
    'people.forwarding.offline.help':
      'Kein Gerät ist angemeldet, z. B. Handy aus.',
    'people.forwarding.to': 'Weiterleiten an',
    'people.forwarding.fallback.ring':
      'Aus: Anrufe klingeln wie gewohnt; die Regeln unten greifen.',
    'people.forwarding.fallback.mailbox':
      'Aus: Der Anruf geht auf die Mailbox.',
    'people.forwarding.fallback.reject':
      'Aus: Der Anruf wird abgewiesen (keine Mailbox).',
    'people.forwarding.fallback.offline':
      'Aus: Es gilt die Regel „Wenn niemand abnimmt“.',
    'people.forwarding.shadowed':
      '„Immer“ ist eingeschaltet – diese Regel greift dann nicht.',
    'people.forwarding.saved': 'Weiterleitung gespeichert',

    'people.devices.addPhone': 'Telefon hinzufügen',
    'people.devices.addRingotel': 'Ringotel-App einrichten',
    'people.devices.manualIntroCreate':
      'Ein Tisch- oder Softphone, das Sie selbst einrichten. Die Zugangsdaten sehen Sie gleich danach einmal.',
    'people.devices.ringotelIntroCreate':
      'Die Handy-App. Zugangsdaten gehen automatisch an Ringotel; höchstens eine pro Person.',
    'people.devices.labelPlaceholder': 'z. B. Schreibtisch',
    'people.devices.kind.manual': 'Telefon',
    'people.devices.kind.ringotel': 'Ringotel-App',
    'people.devices.tls': 'TLS (überall)',
    'people.devices.plain': 'UDP/TCP',
    'people.devices.plainHelp':
      'Unverschlüsselt, nur von den erlaubten IP-Adressen',
    'people.devices.registered': 'angemeldet {when}',
    'people.devices.neverRegistered': 'noch nie angemeldet',
    'people.devices.needsExtension':
      'Geräte brauchen eine Durchwahl. Geben Sie der Person zuerst eine.',
    'people.devices.empty': 'Noch keine Geräte',
    'people.devices.emptyBody':
      'Richten Sie die Ringotel-App oder ein Telefon ein.',
    'people.devices.created': '{label} hinzugefügt',
    'people.devices.updated': 'Gerät gespeichert',
    'people.devices.deleted': '{label} entfernt',
    'people.devices.edit': 'Gerät bearbeiten',
    'people.devices.delete': 'Gerät entfernen',
    'people.devices.reveal': 'Zugangsdaten anzeigen',
    'people.devices.rotate': 'Neues SIP-Passwort',
    'people.devices.rotated': 'Neues SIP-Passwort erstellt',
    'people.devices.settingsTitle': 'Einrichtung: {label}',
    'people.devices.settingsIntro': 'Tragen Sie diese Werte im Telefon ein.',
    'people.devices.ringotelIntro':
      'Die App bekommt diese Daten automatisch; Sie brauchen sie nur zur Fehlersuche.',
    'people.devices.revealTitle': 'Zugangsdaten: {label}',
    'people.devices.rotatedTitle': 'Neues Passwort: {label}',
    'people.devices.rotatedManual':
      'Das Telefon meldet sich erst wieder an, wenn das neue Passwort eingetragen ist.',
    'people.devices.rotatedRingotel':
      'Das neue Passwort ging automatisch an Ringotel.',

    'people.conn.server': 'Server',
    'people.conn.domain': 'Domain',
    'people.conn.transport': 'Transport',
    'people.conn.port': 'Port',
    'people.conn.username': 'SIP-Benutzer',
    'people.conn.password': 'Passwort',
    'people.conn.extension': 'Durchwahl',
    'people.conn.displayName': 'Anzeigename',
    'people.conn.mediaEncryption': 'Sprachverschlüsselung',
    'people.conn.codecs': 'Codecs',
    'people.conn.voicemailCode': 'Mailbox-Code',
    'people.conn.once': 'Nur jetzt sichtbar – bitte sicher aufbewahren.',

    'people.blf.show': 'Tasten-Panel (BLF)',
    'people.blf.hide': 'Panel ausblenden',
    'people.blf.all': 'Leer: Die App zeigt alle Kolleg:innen und Rufgruppen.',
    'people.blf.add': 'Taste hinzufügen …',
    'people.blf.parking': 'Parkplatz',
    'people.blf.reset': 'Alle anzeigen',
    'people.blf.saved': 'Tasten-Panel gespeichert',

    'people.tokens.intro':
      'Für Programme wie ein CRM, die in Ihrem Namen auf die Telefonanlage zugreifen. Jedes Token wird nur einmal angezeigt.',
    'people.tokens.add': 'Token erstellen',
    'people.tokens.addIntro':
      'Geben Sie dem Token den Namen des Programms, das es nutzt.',
    'people.tokens.lastUsed': 'Zuletzt genutzt',
    'people.tokens.neverUsed': 'noch nie',
    'people.tokens.status.active': 'aktiv',
    'people.tokens.status.expired': 'abgelaufen',
    'people.tokens.status.revoked': 'widerrufen',
    'people.tokens.revoke': 'Widerrufen',
    'people.tokens.revoked': 'Token „{name}“ widerrufen',
    'people.tokens.created': 'Token „{name}“ erstellt',
    'people.tokens.createdTitle': 'Token „{name}“',
    'people.tokens.createdIntro':
      'Kopieren Sie das Token jetzt in das Programm.',
    'people.tokens.value': 'Token',
    'people.tokens.once':
      'Nur jetzt sichtbar – danach lässt es sich nicht mehr anzeigen.',
    'people.tokens.days': '{n} Tage',
    'people.tokens.year': '1 Jahr',
    'people.tokens.pickDate': 'Datum …',
    'people.tokens.empty': 'Keine Zugriffstoken',
    'people.tokens.emptyBody':
      'Erstellen Sie eines, wenn ein Programm Zugriff braucht.',
    'people.tokens.cannotLogIn':
      'Diese Person kann sich nicht anmelden (keine E-Mail oder als Inhaber:in noch kein Passwort) und daher keine Tokens haben.',

    'people.greeting.title': 'Ihre Mailbox-Ansage',
    'people.greeting.intro':
      'Was Anrufende hören, bevor sie Ihnen eine Nachricht hinterlassen.',
    'people.greeting.own': 'Eigene Ansage',
    'people.greeting.since': 'seit {date}',
    'people.greeting.defaultHelp':
      'Anrufende hören die Standardansage in der Firmensprache.',
    'people.greeting.upload': 'Ansage hochladen',
    'people.greeting.replace': 'Neue Ansage hochladen',
    'people.greeting.clear': 'Ansage entfernen',
    'people.greeting.uploaded': 'Ansage gespeichert',
    'people.greeting.cleared': 'Ansage entfernt',
    'people.greeting.byPhone':
      'WAV oder MP3. Oder am Telefon {code} wählen und die Ansage aufsprechen.',
    'people.greeting.mailbox': 'Ihre Mailbox',
    'people.greeting.messages': 'Nachrichten',
    'people.greeting.messageCount': '{count} ({unread} neu)',
    'people.greeting.listen': 'Mailbox abhören',
    'people.greeting.mailboxOff':
      'Ihre Mailbox ist ausgeschaltet; die Ansage wird erst gespielt, wenn sie eingeschaltet ist.',

    'people.presence.now': 'Ihr Status',
    'people.presence.dndOnHelp':
      'An: Anrufe folgen Ihrer Regel „Bei Nicht stören“; ohne Regel gehen sie an die Mailbox.',
    'people.presence.dndOffHelp': 'Aus: Anrufe klingeln wie gewohnt.',
    'people.presence.dndOnDone': '„Nicht stören“ ist an',
    'people.presence.dndOffDone': '„Nicht stören“ ist aus',
    'people.presence.byPhone': 'Am Telefon: {code}',

    'people.me.forwardingIntro':
      'Wohin Ihre Anrufe gehen, wenn Sie nicht rangehen können. Ohne Regel landet der Anruf auf Ihrer Mailbox.',
    'people.me.devicesIntro':
      'Ihre Telefone und die Ringotel-App. Neue Geräte verbinden sich verschlüsselt (TLS).',

    'people.groups.subtitle':
      'Gruppen von Personen für Rufgruppen und ausgehende Routen. Gruppen lassen sich verschachteln.',
    'people.groups.add': 'Gruppe anlegen',
    'people.groups.drawerIntro':
      'Mitglieder sind Personen oder andere Gruppen.',
    'people.groups.namePlaceholder': 'z. B. Steuerberatung',
    'people.groups.peopleCount': '{n} Personen',
    'people.groups.nestedCount': '{n} Untergruppen',
    'people.groups.usedBy': 'Verwendet in',
    'people.groups.unused': 'nirgends',
    'people.groups.route': 'Route {n}',
    'people.groups.use.ringGroup': 'Rufgruppe',
    'people.groups.use.route': 'Ausgehende Route',
    'people.groups.use.userGroup': 'Gruppe',
    'people.groups.reach': 'Erreicht insgesamt {n} Personen.',
    'people.groups.empty': 'Noch keine Gruppen',
    'people.groups.emptyBody':
      'Fassen Sie Personen zusammen, um sie in Rufgruppen zu verwenden.',
    'people.groups.created': 'Gruppe {name} angelegt',
    'people.groups.saved': 'Gruppe {name} gespeichert',
    'people.groups.deleted': 'Gruppe {name} gelöscht',

    'field.user.name': 'Name',
    'field.user.email': 'E-Mail',
    'field.user.email.help':
      'Für die Anmeldung und Benachrichtigungen. Leer: nur Telefon, ohne Anmeldung.',
    'field.user.extension': 'Durchwahl',
    'field.user.extension.help':
      'Die interne Nummer für Kolleg:innen. Leer: keine Geräte, nicht anrufbar.',
    'field.user.role': 'Rolle',
    'field.user.role.help':
      'Inhaber:innen und Admins richten die Anlage ein; Mitarbeiter:innen nur ihre eigenen Einstellungen.',
    'field.user.ringTimeoutS': 'Klingeldauer',
    'field.user.ringTimeoutS.help':
      'So lange klingeln die Geräte, bevor „Wenn niemand abnimmt“ greift.',
    'field.user.notifyMissedCalls': 'Verpasste Anrufe per E-Mail',
    'field.user.clir': 'Eigene Nummer bei ausgehenden Anrufen',
    'field.user.rejectAnonymous': 'Anrufe mit unterdrückter Nummer',
    'field.user.findMe': 'Parallelruf',
    'field.user.findMe.help':
      'Externe Nummern, die bei direkten Anrufen mitklingeln; zum Annehmen dort die 1 drücken.',
    'field.user.callerIdDidId': 'Absendernummer',
    'field.user.callerIdDidId.help': 'Diese Nummer sehen Angerufene.',
    'field.user.recordCalls': 'Gesprächsaufzeichnung',
    'field.user.recordCalls.help': 'Nur mit Einwilligung der Beteiligten.',
    'field.user.mailboxEnabled': 'Mailbox',
    'field.user.mailboxMaxMessages': 'Höchstzahl Nachrichten',
    'field.user.mailboxMaxMessages.help':
      'Ist die Mailbox voll, erfahren Anrufende das und können keine Nachricht hinterlassen. Leer: unbegrenzt.',
    'field.user.mailboxAudioId': 'Mailbox-Ansage',
    'field.user.logLevel': 'Diagnosestufe',
    'field.user.logLevelExpiresAt': 'Diagnose bis',
    'field.user.rules': 'Weiterleitungsregeln',
    'field.user.dnd': 'Nicht stören',
    'field.user.upload': 'Ansage (WAV oder MP3)',
    'field.device.label': 'Bezeichnung',
    'field.device.kind': 'Art',
    'field.device.transport': 'Verbindung',
    'field.device.transport.help':
      'TLS: verschlüsselt, von überall. UDP/TCP: unverschlüsselt, nur von erlaubten IP-Adressen.',
    'field.device.allowedIps': 'Erlaubte IP-Adressen',
    'field.device.allowedIps.help':
      'IPv4/IPv6-Adressen oder Bereiche (CIDR), von denen das Telefon sich anmelden darf.',
    'field.device.keys': 'Tasten-Panel',
    'field.device.keys.help':
      'Die Lampen der App zeigen, wer gerade telefoniert – in dieser Reihenfolge.',
    'field.personalAccessToken.name': 'Name',
    'field.personalAccessToken.name.help':
      'Welches Programm das Token nutzt, z. B. crm-sync.',
    'field.personalAccessToken.expiresAt': 'Gültig bis',
    'field.userGroup.name': 'Name',
    'field.userGroup.members': 'Mitglieder',

    'confirm.users.delete.title': 'Person löschen?',
    'confirm.users.delete.body':
      '{what} wird gelöscht, mit Geräten, Durchwahl und Anmeldungen. Das lässt sich {days} Tage lang rückgängig machen.',
    'confirm.users.delete.action': 'Löschen',
    'confirm.users.delete.anytime.title': 'Person löschen?',
    'confirm.users.delete.anytime.body':
      '{what} wird gelöscht, mit Geräten, Durchwahl und Anmeldungen. Das lässt sich jederzeit rückgängig machen.',
    'confirm.users.delete.anytime.action': 'Löschen',
    'confirm.users.erase.title': 'Personendaten endgültig löschen?',
    'confirm.users.erase.body':
      '{name} wird gelöscht, und Name, E-Mail und Rufnummern verschwinden aus dem Änderungsprotokoll.',
    'confirm.users.erase.action': 'Endgültig löschen',
    'confirm.users.resetMfa.title': 'Zwei-Faktor-Anmeldung zurücksetzen?',
    'confirm.users.resetMfa.body':
      'Authenticator-App, Passkeys und Wiederherstellungscodes von {name} werden entfernt, und alle Sitzungen enden.',
    'confirm.users.resetMfa.action': 'Zurücksetzen',
    'confirm.users.clearVoicemailGreeting.title': 'Mailbox-Ansage entfernen?',
    'confirm.users.clearVoicemailGreeting.body':
      'Anrufende hören danach die Standardansage.',
    'confirm.users.clearVoicemailGreeting.action': 'Entfernen',
    'confirm.devices.delete.title': 'Gerät entfernen?',
    'confirm.devices.delete.body':
      '„{what}“ kann danach nicht mehr telefonieren. Das lässt sich {days} Tage lang rückgängig machen.',
    'confirm.devices.delete.action': 'Entfernen',
    'confirm.devices.delete.anytime.title': 'Gerät entfernen?',
    'confirm.devices.delete.anytime.body':
      '„{what}“ kann danach nicht mehr telefonieren. Das lässt sich jederzeit rückgängig machen.',
    'confirm.devices.delete.anytime.action': 'Entfernen',
    'confirm.devices.rotate.title': 'Neues SIP-Passwort?',
    'confirm.devices.rotate.body':
      '„{label}“ meldet sich erst wieder an, wenn es das neue Passwort hat.',
    'confirm.devices.rotate.action': 'Neues Passwort',
    'confirm.personalAccessTokens.revoke.title': 'Token widerrufen?',
    'confirm.personalAccessTokens.revoke.body':
      'Das Programm hinter „{name}“ verliert sofort den Zugriff.',
    'confirm.personalAccessTokens.revoke.action': 'Widerrufen',
    'confirm.userGroups.delete.title': 'Gruppe löschen?',
    'confirm.userGroups.delete.body':
      'Rufgruppen und Routen überspringen „{what}“ danach. Das lässt sich {days} Tage lang rückgängig machen.',
    'confirm.userGroups.delete.action': 'Löschen',
    'confirm.userGroups.delete.anytime.title': 'Gruppe löschen?',
    'confirm.userGroups.delete.anytime.body':
      'Rufgruppen und Routen überspringen „{what}“ danach. Das lässt sich jederzeit rückgängig machen.',
    'confirm.userGroups.delete.anytime.action': 'Löschen',

    'errors.people.email': '„{value}“ ist keine gültige E-Mail-Adresse.',
    'errors.people.needsContact':
      'Eine Person braucht eine E-Mail oder eine Durchwahl.',
    'errors.people.roleNeedsEmail':
      'Admins und Inhaber:innen brauchen eine E-Mail, um sich anzumelden.',
    'errors.people.emailTaken': 'Diese E-Mail-Adresse verwendet bereits:',
    'errors.people.adminOnlyField': 'Das können nur Admins ändern.',
    'errors.people.onlyOwnersChangeRoles':
      'Nur Inhaber:innen können Rollen ändern.',
    'errors.people.ownerEmailOwnerOnly':
      'Die E-Mail-Adresse von Inhaber:innen können nur Inhaber:innen ändern.',
    'errors.people.lastOwner':
      'Es muss mindestens eine Inhaber:in mit Passwort bleiben:',
    'errors.people.callerIdUnknown': 'Diese Absendernummer gibt es nicht.',
    'errors.people.callerIdNotNumeric':
      'Die Absendernummer muss eine echte Rufnummer sein.',
    'errors.people.findMeOwnDid':
      '{number} ist eine eigene Firmennummer. Fügen Sie die Person direkt hinzu.',
    'errors.people.greetingKind': 'Bitte eine Mailbox-Ansage wählen.',
    'errors.people.logLevelExpiry':
      'Ein Ablaufdatum braucht eine Diagnosestufe.',
    'errors.people.extensionHasDevices':
      'An dieser Durchwahl hängen noch Geräte. Entfernen Sie diese zuerst:',
    'errors.people.extensionInRingGroups':
      'Die Person ist noch in Rufgruppen. Entfernen Sie sie dort zuerst:',
    'errors.people.noEmail':
      'Ohne E-Mail gibt es keine Anmeldung und kein Passwort.',
    'errors.people.duplicateCondition':
      'Pro Bedingung ist nur eine Regel möglich.',
    'errors.people.sipTargetAdminOnly':
      'SIP-Ziele können nur Admins einrichten.',
    'errors.people.recordTargetAdminOnly':
      'Aufgezeichnete Weiterleitungen können nur Admins einrichten.',
    'errors.people.greetingFormat': '„{name}“ ist keine WAV- oder MP3-Datei.',
    'errors.people.deviceNeedsExtension':
      'Geräte brauchen eine Durchwahl. Vergeben Sie zuerst eine für:',
    'errors.people.plainNeedsIps':
      'UDP/TCP-Geräte brauchen mindestens eine erlaubte IP-Adresse.',
    'errors.people.invalidIp':
      '„{value}“ ist keine IP-Adresse oder kein Bereich.',
    'errors.people.ipsPlainOnly':
      'Erlaubte IP-Adressen gibt es nur bei UDP/TCP-Geräten.',
    'errors.people.ringotelTls':
      'Die Ringotel-App verbindet sich immer über TLS.',
    'errors.people.oneRingotel': 'Pro Person gibt es nur eine Ringotel-App:',
    'errors.people.blfRingotelOnly':
      'Tasten-Panels gibt es nur in der Ringotel-App.',
    'errors.people.blfNotExtension': '{key} ist keine vergebene Durchwahl.',
    'errors.people.tokenCannotLogIn':
      'Diese Person kann sich nicht anmelden und daher keine Tokens haben:',
    'errors.people.tokenNameLength': 'Höchstens {max} Zeichen.',
    'errors.people.tokenExpiryInvalid': 'Bitte ein gültiges Datum angeben.',
    'errors.people.tokenExpiryPast': 'Das Datum muss in der Zukunft liegen.',
    'errors.people.tokenNameTaken':
      'Ein aktives Token mit diesem Namen gibt es schon:',
    'errors.people.tokenRevoked': 'Dieses Token ist schon widerrufen.',
    'errors.people.groupNameTaken':
      'Eine Gruppe mit diesem Namen gibt es schon:',
    'errors.people.duplicateMember':
      'Jedes Mitglied kann nur einmal hinzugefügt werden.',
    'errors.people.groupCycle':
      'Die Gruppe würde sich selbst enthalten: {path}.'
  },
  en: {
    'people.ext': 'Ext. {ext}',
    'people.phoneOnly': 'phone only',
    'people.noExtension': 'no extension',
    'people.discard': 'Discard',
    'people.unsaved': 'Unsaved changes',
    'people.done': 'Done',
    'people.secondsShort': 's',
    'people.inherit': 'Default ({value})',
    'people.mfa': 'Two-factor',
    'people.mfa.on': 'on',
    'people.mfa.off': 'not set up',

    'people.tab.profile': 'Profile',
    'people.tab.devices': 'Devices',
    'people.tab.forwarding': 'Forwarding',
    'people.tab.schedule': 'Absence & hours',
    'people.tab.tokens': 'Access tokens',
    'people.tab.greeting': 'Voicemail greeting',
    'people.tab.security': 'Security',

    'people.users.subtitle':
      'Everyone with their extension, sign-in and devices.',
    'people.users.add': 'Add person',
    'people.users.addIntro':
      'With an e-mail, the person gets a link to set their password. Without one, they are reachable by phone only.',
    'people.users.search': 'Name, extension or e-mail',
    'people.users.empty': 'Nobody found',
    'people.users.emptyBody': 'Change the search or add a person.',
    'people.users.notFound': 'Person not found',
    'people.users.notFoundBody': 'This person was deleted or does not exist.',
    'people.users.emailPlaceholder': 'leave empty: phone only',
    'people.users.namePlaceholder': 'e.g. Anna Example',
    'people.users.phoneOnlyNote':
      'Without an e-mail the person cannot sign in; they then need an extension.',
    'people.users.created': '{name} added',
    'people.users.setupLink': 'Link to set the password',
    'people.users.setupLinkNote':
      'Shown only now. It was also e-mailed and is valid for 7 days.',
    'people.users.noSetupLink':
      'Without an e-mail there is no sign-in and no link.',
    'people.users.ringotelTitle': 'Ringotel app for the phone',
    'people.users.ringotelBody':
      'Set up the app right away; the credentials go to Ringotel automatically.',
    'people.users.ringotelDone': 'The app is set up.',
    'people.users.addAnother': 'Add another',
    'people.users.openProfile': 'Open profile',
    'people.users.resetPassword': 'Send password link',
    'people.users.resetSent': 'New password link for {name}',
    'people.users.resetTitle': 'Password link for {name}',
    'people.users.resetIntro':
      'The person sets a new password with it. The link was e-mailed to them as well.',
    'people.users.resetMfa': 'Reset two-factor sign-in',
    'people.users.mfaReset': 'Two-factor sign-in reset for {name}',
    'people.users.delete': 'Delete person',
    'people.users.deleted': '{name} deleted',
    'people.users.erase': 'Erase personal data (GDPR)',
    'people.users.erased': 'Personal data erased',
    'people.users.locked': 'Sign-in locked until {until}',

    'people.profile.person': 'Person',
    'people.profile.calls': 'Calls',
    'people.profile.mailbox': 'Voicemail & notifications',
    'people.profile.saved': 'Saved',
    'people.callerId.main': 'Main number ({number})',
    'people.clir.on': 'Withhold number',
    'people.clir.off': 'Show number',
    'people.reject.on': 'Refuse anonymous',
    'people.reject.off': 'Accept anonymous',
    'people.recordCalls.switch': "Record all of this person's calls",
    'people.recordCalls.on': 'Calls are recorded',
    'people.recordCalls.off': 'Not recorded',
    'people.mailbox.switch': 'Voicemail takes messages',
    'people.notify.switch': 'E-mail for every missed call',
    'people.greeting.default': 'Default greeting',

    'people.findMe.legs': 'Additional numbers',
    'people.findMe.empty':
      'No additional numbers. Calls ring on your devices only.',
    'people.findMe.add': 'Add number',
    'people.findMe.after': 'after',
    'people.findMe.immediately': 'immediately',
    'people.findMe.afterSeconds': 'after {s} s',

    'people.forwarding.unconditional': 'Always',
    'people.forwarding.unconditional.help':
      'Every call is forwarded right away.',
    'people.forwarding.busy': 'When busy',
    'people.forwarding.busy.help': 'All your devices are on a call.',
    'people.forwarding.noAnswer': 'When nobody answers',
    'people.forwarding.noAnswer.help': 'After the ring time.',
    'people.forwarding.dnd': 'On do not disturb',
    'people.forwarding.dnd.help': 'While do not disturb is on.',
    'people.forwarding.offline': 'When unreachable',
    'people.forwarding.offline.help':
      'No device is signed in, e.g. the phone is off.',
    'people.forwarding.to': 'Forward to',
    'people.forwarding.fallback.ring':
      'Off: calls ring as usual; the rules below apply.',
    'people.forwarding.fallback.mailbox': 'Off: the call goes to voicemail.',
    'people.forwarding.fallback.reject':
      'Off: the call is rejected (no voicemail).',
    'people.forwarding.fallback.offline':
      'Off: the "When nobody answers" rule applies.',
    'people.forwarding.shadowed':
      '"Always" is on, so this rule does not apply.',
    'people.forwarding.saved': 'Forwarding saved',

    'people.devices.addPhone': 'Add phone',
    'people.devices.addRingotel': 'Set up Ringotel app',
    'people.devices.manualIntroCreate':
      'A desk phone or softphone you set up yourself. Its credentials are shown once, right afterwards.',
    'people.devices.ringotelIntroCreate':
      'The phone app. Credentials go to Ringotel automatically; at most one per person.',
    'people.devices.labelPlaceholder': 'e.g. Desk',
    'people.devices.kind.manual': 'Phone',
    'people.devices.kind.ringotel': 'Ringotel app',
    'people.devices.tls': 'TLS (anywhere)',
    'people.devices.plain': 'UDP/TCP',
    'people.devices.plainHelp':
      'Unencrypted, from the allowed IP addresses only',
    'people.devices.registered': 'signed in {when}',
    'people.devices.neverRegistered': 'never signed in',
    'people.devices.needsExtension':
      'Devices need an extension. Give the person one first.',
    'people.devices.empty': 'No devices yet',
    'people.devices.emptyBody': 'Set up the Ringotel app or a phone.',
    'people.devices.created': '{label} added',
    'people.devices.updated': 'Device saved',
    'people.devices.deleted': '{label} removed',
    'people.devices.edit': 'Edit device',
    'people.devices.delete': 'Remove device',
    'people.devices.reveal': 'Show credentials',
    'people.devices.rotate': 'New SIP password',
    'people.devices.rotated': 'New SIP password created',
    'people.devices.settingsTitle': 'Setup: {label}',
    'people.devices.settingsIntro': 'Enter these values in the phone.',
    'people.devices.ringotelIntro':
      'The app receives these automatically; you only need them for troubleshooting.',
    'people.devices.revealTitle': 'Credentials: {label}',
    'people.devices.rotatedTitle': 'New password: {label}',
    'people.devices.rotatedManual':
      'The phone signs in again only once it has the new password.',
    'people.devices.rotatedRingotel':
      'The new password went to Ringotel automatically.',

    'people.conn.server': 'Server',
    'people.conn.domain': 'Domain',
    'people.conn.transport': 'Transport',
    'people.conn.port': 'Port',
    'people.conn.username': 'SIP user',
    'people.conn.password': 'Password',
    'people.conn.extension': 'Extension',
    'people.conn.displayName': 'Display name',
    'people.conn.mediaEncryption': 'Media encryption',
    'people.conn.codecs': 'Codecs',
    'people.conn.voicemailCode': 'Voicemail code',
    'people.conn.once': 'Shown only now. Keep it safe.',

    'people.blf.show': 'Key panel (BLF)',
    'people.blf.hide': 'Hide panel',
    'people.blf.all': 'Empty: the app shows every colleague and ring group.',
    'people.blf.add': 'Add key …',
    'people.blf.parking': 'Parking slot',
    'people.blf.reset': 'Show all',
    'people.blf.saved': 'Key panel saved',

    'people.tokens.intro':
      'For programs such as a CRM that use the phone system on your behalf. Each token is shown once.',
    'people.tokens.add': 'Create token',
    'people.tokens.addIntro': 'Name the token after the program that uses it.',
    'people.tokens.lastUsed': 'Last used',
    'people.tokens.neverUsed': 'never',
    'people.tokens.status.active': 'active',
    'people.tokens.status.expired': 'expired',
    'people.tokens.status.revoked': 'revoked',
    'people.tokens.revoke': 'Revoke',
    'people.tokens.revoked': 'Token "{name}" revoked',
    'people.tokens.created': 'Token "{name}" created',
    'people.tokens.createdTitle': 'Token "{name}"',
    'people.tokens.createdIntro': 'Copy the token into the program now.',
    'people.tokens.value': 'Token',
    'people.tokens.once': 'Shown only now; it cannot be displayed again.',
    'people.tokens.days': '{n} days',
    'people.tokens.year': '1 year',
    'people.tokens.pickDate': 'Date …',
    'people.tokens.empty': 'No access tokens',
    'people.tokens.emptyBody': 'Create one when a program needs access.',
    'people.tokens.cannotLogIn':
      'This person cannot sign in (no e-mail, or an owner without a password yet), so they cannot have tokens.',

    'people.greeting.title': 'Your voicemail greeting',
    'people.greeting.intro':
      'What callers hear before they leave you a message.',
    'people.greeting.own': 'Your own greeting',
    'people.greeting.since': 'since {date}',
    'people.greeting.defaultHelp':
      'Callers hear the default greeting in the company language.',
    'people.greeting.upload': 'Upload greeting',
    'people.greeting.replace': 'Upload new greeting',
    'people.greeting.clear': 'Remove greeting',
    'people.greeting.uploaded': 'Greeting saved',
    'people.greeting.cleared': 'Greeting removed',
    'people.greeting.byPhone':
      'WAV or MP3. Or dial {code} on your phone and record it.',
    'people.greeting.mailbox': 'Your voicemail',
    'people.greeting.messages': 'Messages',
    'people.greeting.messageCount': '{count} ({unread} new)',
    'people.greeting.listen': 'Listen to voicemail',
    'people.greeting.mailboxOff':
      'Your voicemail is off; the greeting plays once it is on.',

    'people.presence.now': 'Your status',
    'people.presence.dndOnHelp':
      'On: calls follow your "On do not disturb" rule, or go to voicemail if there is none.',
    'people.presence.dndOffHelp': 'Off: calls ring as usual.',
    'people.presence.dndOnDone': 'Do not disturb is on',
    'people.presence.dndOffDone': 'Do not disturb is off',
    'people.presence.byPhone': 'On the phone: {code}',

    'people.me.forwardingIntro':
      'Where your calls go when you cannot answer. Without a rule the call goes to your voicemail.',
    'people.me.devicesIntro':
      'Your phones and the Ringotel app. New devices connect with encryption (TLS).',

    'people.groups.subtitle':
      'Groups of people for ring groups and outbound routes. Groups can be nested.',
    'people.groups.add': 'Add group',
    'people.groups.drawerIntro': 'Members are people or other groups.',
    'people.groups.namePlaceholder': 'e.g. Tax advisory',
    'people.groups.peopleCount': '{n} people',
    'people.groups.nestedCount': '{n} subgroups',
    'people.groups.usedBy': 'Used in',
    'people.groups.unused': 'nowhere',
    'people.groups.route': 'Route {n}',
    'people.groups.use.ringGroup': 'Ring group',
    'people.groups.use.route': 'Outbound route',
    'people.groups.use.userGroup': 'Group',
    'people.groups.reach': 'Reaches {n} people in all.',
    'people.groups.empty': 'No groups yet',
    'people.groups.emptyBody': 'Group people to use them in ring groups.',
    'people.groups.created': 'Group {name} added',
    'people.groups.saved': 'Group {name} saved',
    'people.groups.deleted': 'Group {name} deleted',

    'field.user.name': 'Name',
    'field.user.email': 'E-mail',
    'field.user.email.help':
      'For sign-in and notifications. Empty: phone only, no sign-in.',
    'field.user.extension': 'Extension',
    'field.user.extension.help':
      'The internal number colleagues dial. Empty: no devices, not callable.',
    'field.user.role': 'Role',
    'field.user.role.help':
      'Owners and admins configure the system; users only their own settings.',
    'field.user.ringTimeoutS': 'Ring time',
    'field.user.ringTimeoutS.help':
      'How long the devices ring before "When nobody answers" applies.',
    'field.user.notifyMissedCalls': 'Missed calls by e-mail',
    'field.user.clir': 'Own number on outbound calls',
    'field.user.rejectAnonymous': 'Calls with withheld number',
    'field.user.findMe': 'Find me',
    'field.user.findMe.help':
      'External numbers that ring along on direct calls; press 1 there to take the call.',
    'field.user.callerIdDidId': 'Caller ID',
    'field.user.callerIdDidId.help': 'The number the people you call see.',
    'field.user.recordCalls': 'Call recording',
    'field.user.recordCalls.help':
      'Only with the consent of everyone on the call.',
    'field.user.mailboxEnabled': 'Voicemail',
    'field.user.mailboxMaxMessages': 'Maximum messages',
    'field.user.mailboxMaxMessages.help':
      'When the voicemail is full, callers are told so and cannot leave a message. Empty: unlimited.',
    'field.user.mailboxAudioId': 'Voicemail greeting',
    'field.user.logLevel': 'Diagnostics level',
    'field.user.logLevelExpiresAt': 'Diagnostics until',
    'field.user.rules': 'Forwarding rules',
    'field.user.dnd': 'Do not disturb',
    'field.user.upload': 'Greeting (WAV or MP3)',
    'field.device.label': 'Label',
    'field.device.kind': 'Type',
    'field.device.transport': 'Connection',
    'field.device.transport.help':
      'TLS: encrypted, from anywhere. UDP/TCP: unencrypted, from allowed IP addresses only.',
    'field.device.allowedIps': 'Allowed IP addresses',
    'field.device.allowedIps.help':
      'IPv4/IPv6 addresses or ranges (CIDR) the phone may sign in from.',
    'field.device.keys': 'Key panel',
    'field.device.keys.help':
      "The app's lamps show who is on a call, in this order.",
    'field.personalAccessToken.name': 'Name',
    'field.personalAccessToken.name.help':
      'Which program uses the token, e.g. crm-sync.',
    'field.personalAccessToken.expiresAt': 'Valid until',
    'field.userGroup.name': 'Name',
    'field.userGroup.members': 'Members',

    'confirm.users.delete.title': 'Delete this person?',
    'confirm.users.delete.body':
      '{what} is deleted, with their devices, extension and sign-ins. This can be undone for {days} days.',
    'confirm.users.delete.action': 'Delete',
    'confirm.users.delete.anytime.title': 'Delete this person?',
    'confirm.users.delete.anytime.body':
      '{what} is deleted, with their devices, extension and sign-ins. This can be undone at any time.',
    'confirm.users.delete.anytime.action': 'Delete',
    'confirm.users.erase.title': 'Erase personal data for good?',
    'confirm.users.erase.body':
      '{name} is deleted, and their name, e-mail and numbers disappear from the audit log.',
    'confirm.users.erase.action': 'Erase for good',
    'confirm.users.resetMfa.title': 'Reset two-factor sign-in?',
    'confirm.users.resetMfa.body':
      "{name}'s authenticator app, passkeys and recovery codes are removed, and every session ends.",
    'confirm.users.resetMfa.action': 'Reset',
    'confirm.users.clearVoicemailGreeting.title':
      'Remove the voicemail greeting?',
    'confirm.users.clearVoicemailGreeting.body':
      'Callers hear the default greeting afterwards.',
    'confirm.users.clearVoicemailGreeting.action': 'Remove',
    'confirm.devices.delete.title': 'Remove this device?',
    'confirm.devices.delete.body':
      '"{what}" can no longer make calls. This can be undone for {days} days.',
    'confirm.devices.delete.action': 'Remove',
    'confirm.devices.delete.anytime.title': 'Remove this device?',
    'confirm.devices.delete.anytime.body':
      '"{what}" can no longer make calls. This can be undone at any time.',
    'confirm.devices.delete.anytime.action': 'Remove',
    'confirm.devices.rotate.title': 'New SIP password?',
    'confirm.devices.rotate.body':
      '"{label}" signs in again only once it has the new password.',
    'confirm.devices.rotate.action': 'New password',
    'confirm.personalAccessTokens.revoke.title': 'Revoke this token?',
    'confirm.personalAccessTokens.revoke.body':
      'The program behind "{name}" loses access at once.',
    'confirm.personalAccessTokens.revoke.action': 'Revoke',
    'confirm.userGroups.delete.title': 'Delete this group?',
    'confirm.userGroups.delete.body':
      'Ring groups and routes skip "{what}" afterwards. This can be undone for {days} days.',
    'confirm.userGroups.delete.action': 'Delete',
    'confirm.userGroups.delete.anytime.title': 'Delete this group?',
    'confirm.userGroups.delete.anytime.body':
      'Ring groups and routes skip "{what}" afterwards. This can be undone at any time.',
    'confirm.userGroups.delete.anytime.action': 'Delete',

    'errors.people.email': '"{value}" is not a valid e-mail address.',
    'errors.people.needsContact': 'A person needs an e-mail or an extension.',
    'errors.people.roleNeedsEmail':
      'Admins and owners need an e-mail to sign in.',
    'errors.people.emailTaken': 'This e-mail already belongs to:',
    'errors.people.adminOnlyField': 'Only admins can change this.',
    'errors.people.onlyOwnersChangeRoles': 'Only owners can change roles.',
    'errors.people.ownerEmailOwnerOnly':
      "Only owners can change an owner's e-mail.",
    'errors.people.lastOwner':
      'At least one owner with a password must remain:',
    'errors.people.callerIdUnknown': 'This caller ID does not exist.',
    'errors.people.callerIdNotNumeric':
      'The caller ID must be a real phone number.',
    'errors.people.findMeOwnDid':
      "{number} is one of the company's own numbers. Add the person directly instead.",
    'errors.people.greetingKind': 'Please choose a voicemail greeting.',
    'errors.people.logLevelExpiry': 'An expiry needs a diagnostics level.',
    'errors.people.extensionHasDevices':
      'Devices are still attached to this extension. Remove them first:',
    'errors.people.extensionInRingGroups':
      'The person is still in ring groups. Remove them there first:',
    'errors.people.noEmail':
      'Without an e-mail there is no sign-in and no password.',
    'errors.people.duplicateCondition': 'Only one rule per condition.',
    'errors.people.sipTargetAdminOnly': 'Only admins can set up SIP targets.',
    'errors.people.recordTargetAdminOnly':
      'Only admins can set up recorded forwarding.',
    'errors.people.greetingFormat': '"{name}" is not a WAV or MP3 file.',
    'errors.people.deviceNeedsExtension':
      'Devices need an extension. Assign one first for:',
    'errors.people.plainNeedsIps':
      'UDP/TCP devices need at least one allowed IP address.',
    'errors.people.invalidIp': '"{value}" is not an IP address or range.',
    'errors.people.ipsPlainOnly':
      'Allowed IP addresses apply to UDP/TCP devices only.',
    'errors.people.ringotelTls': 'The Ringotel app always connects over TLS.',
    'errors.people.oneRingotel': 'There is one Ringotel app per person:',
    'errors.people.blfRingotelOnly':
      'Key panels exist in the Ringotel app only.',
    'errors.people.blfNotExtension': '{key} is not an assigned extension.',
    'errors.people.tokenCannotLogIn':
      'This person cannot sign in, so they cannot have tokens:',
    'errors.people.tokenNameLength': 'At most {max} characters.',
    'errors.people.tokenExpiryInvalid': 'Please enter a valid date.',
    'errors.people.tokenExpiryPast': 'The date must be in the future.',
    'errors.people.tokenNameTaken':
      'An active token with this name already exists:',
    'errors.people.tokenRevoked': 'This token is already revoked.',
    'errors.people.groupNameTaken': 'A group with this name already exists:',
    'errors.people.duplicateMember': 'Each member can only be added once.',
    'errors.people.groupCycle': 'The group would contain itself: {path}.'
  }
} satisfies Messages;
