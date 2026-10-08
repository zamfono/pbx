import type { Messages } from '../index.svelte';

export default {
  de: {
    'numbers.subtitle': 'Die Rufnummern der Firma und wohin ihre Anrufe gehen.',
    'numbers.tab.numbers': 'Rufnummern',
    'numbers.tab.blocks': 'Nummernblöcke',
    'numbers.add': 'Rufnummer hinzufügen',
    'numbers.addSubtitle':
      'Eine Rufnummer, die Ihr Anbieter Ihnen zugeteilt hat.',
    'numbers.editSubtitle': 'Rufnummer',
    'numbers.mainNumber': 'Hauptnummer',
    'numbers.mainBadge': 'Hauptnummer',
    'numbers.mainNumberNote':
      'Wird bei ausgehenden Anrufen angezeigt, wenn weder die Route noch die Person eine eigene Nummer vorgibt.',
    'numbers.mainNumberChange': 'In den Einstellungen ändern',
    'numbers.callsGoTo': 'Anrufe gehen an',
    'numbers.block': 'Block',
    'numbers.callerIdOf': '{count}× als Absendernummer',
    'numbers.callerIdOfRoutes': 'Absender in {count} Route(n)',
    'numbers.verbatim': 'Anbieterkennung',
    'numbers.storedAs': 'Wird gespeichert als',
    'numbers.storedVerbatim': 'Keine Rufnummer – wird unverändert verglichen:',
    'numbers.inBlock': 'Gehört zum Nummernblock „{block}“.',
    'numbers.labelPlaceholder': 'z. B. Zentrale, Hotline',
    'numbers.empty': 'Noch keine Rufnummern',
    'numbers.emptyBody':
      'Tragen Sie die Nummern ein, die Ihr Anbieter Ihnen zugeteilt hat, und legen Sie fest, wer rangeht.',
    'numbers.created': '{number} hinzugefügt',
    'numbers.updated': 'Ziel von {number} gespeichert',
    'numbers.deleted': '{number} gelöscht',

    'numbers.addBlock': 'Nummernblock hinzufügen',
    'numbers.addBlockSubtitle':
      'Ein Durchwahlbereich, z. B. 089 4520 0 bis 999.',
    'numbers.blocksIntro':
      'Ein Nummernblock fasst die Durchwahlen eines Anschlusses zusammen. Wird eine Nummer im Block gewählt, die niemandem zugeteilt ist, geht der Anruf an das Ausweichziel – Nummern im Block werden nie als interne Durchwahl behandelt.',
    'numbers.blocksEmpty': 'Keine Nummernblöcke',
    'numbers.blocksEmptyBody':
      'Legen Sie einen Block an, wenn Ihr Anschluss einen Durchwahlbereich hat.',
    'numbers.digitsFixed': 'Feste Länge',
    'numbers.digitsOpen': 'Beliebig lang',
    'numbers.digitsSuffix': 'Stellen',
    'numbers.blockHolds': '{count} Nummern',
    'numbers.patternPreview': 'Muster',
    'numbers.blockLabelPlaceholder': 'z. B. Anschluss München',
    'numbers.companyFallback': 'Firmenweites Ausweichziel',
    'numbers.companyFallbackIs': 'Derzeit:',
    'numbers.noFallback': 'keines – Anruf wird abgewiesen',
    'numbers.openEnded': 'beliebig viele Stellen',
    'numbers.digitsSummary': '{digits} Stellen · {count} Nummern',
    'numbers.assigned': 'Vergeben',
    'numbers.assignedOf': '{count} von {total}',
    'numbers.blockNoNumbers': 'Noch keine Rufnummer in diesem Block.',
    'numbers.blockCreated': 'Nummernblock hinzugefügt',
    'numbers.blockUpdated': 'Nummernblock gespeichert',
    'numbers.blockDeleted': 'Nummernblock gelöscht',

    'field.did.number': 'Rufnummer',
    'field.did.number.help':
      'Wie Sie sie kennen, z. B. 089 4520 155 oder +49 89 4520 155. Später nicht mehr änderbar.',
    'field.did.label': 'Bezeichnung',
    'field.did.label.help':
      'Nur zur Orientierung; wird beim Hinzufügen festgelegt.',
    'field.did.target': 'Anrufe gehen an',
    'field.did.target.help':
      'Wer oder was rangeht. Eine Person ohne eigene Absendernummer bekommt diese Nummer automatisch als Absendernummer.',
    'field.didBlock.base': 'Beginnt mit',
    'field.didBlock.base.help':
      'Der gemeinsame Anfang aller Nummern im Block, z. B. 089 4520. Später nicht mehr änderbar.',
    'field.didBlock.label': 'Bezeichnung',
    'field.didBlock.digits': 'Stellen danach',
    'field.didBlock.digits.help':
      'Wie viele Ziffern auf den Anfang folgen, z. B. 3 für 089 4520 xxx. „Beliebig lang“ umfasst jede Nummer mit diesem Anfang.',
    'field.didBlock.fallbackTarget': 'Ausweichziel',
    'field.didBlock.fallbackTarget.help':
      'Wohin Anrufe für nicht vergebene Nummern im Block gehen – eine Ansage ist dafür ideal.',

    'confirm.dids.delete.title': 'Rufnummer löschen?',
    'confirm.dids.delete.body':
      '{number} nimmt danach keine Anrufe mehr an. Sie können das Löschen {days} Tage lang rückgängig machen.',
    'confirm.dids.delete.action': 'Löschen',
    'confirm.dids.delete.anyTime.title': 'Rufnummer löschen?',
    'confirm.dids.delete.anyTime.body':
      '{number} nimmt danach keine Anrufe mehr an. Sie können das Löschen jederzeit rückgängig machen.',
    'confirm.dids.delete.anyTime.action': 'Löschen',
    'confirm.didBlocks.delete.title': 'Nummernblock löschen?',
    'confirm.didBlocks.delete.body':
      'Der Block {base} und sein Ausweichziel werden entfernt. Sie können das Löschen {days} Tage lang rückgängig machen.',
    'confirm.didBlocks.delete.action': 'Löschen',
    'confirm.didBlocks.delete.anyTime.title': 'Nummernblock löschen?',
    'confirm.didBlocks.delete.anyTime.body':
      'Der Block {base} und sein Ausweichziel werden entfernt. Sie können das Löschen jederzeit rückgängig machen.',
    'confirm.didBlocks.delete.anyTime.action': 'Löschen',

    'errors.numbers.numberRequired': 'Bitte eine Nummer eingeben.',
    'errors.numbers.numberWhitespace':
      'Bitte ohne Leerzeichen eingeben, z. B. 0894520155.',
    'errors.numbers.numberTaken': 'Diese Rufnummer gibt es schon:',
    'errors.numbers.baseTaken': 'Einen Block mit diesem Anfang gibt es schon:',
    'errors.numbers.baseWildcard':
      'Der Anfang darf keine Platzhalter (* ? [ ]) enthalten.',
    'errors.numbers.digitsRange': 'Bitte eine Stellenzahl ab 1 angeben.',
    'errors.numbers.targetExternal':
      'Die externe Nummer muss international sein, z. B. +4917155501234.',
    'errors.numbers.targetSipUser':
      'Der SIP-Benutzer darf nur A–Z, a–z, 0–9 und . _ ~ + - enthalten (1–64 Zeichen).',
    'errors.numbers.mainNumber':
      'Das ist die Hauptnummer der Firma. Legen Sie zuerst eine andere Hauptnummer fest:',
    'errors.numbers.callerIdOfUsers':
      'Diese Nummer ist noch Absendernummer von:',
    'errors.numbers.callerIdOfRoutes':
      'Diese Nummer wird noch von ausgehenden Routen angezeigt:',
    'errors.numbers.blockHasNumbers':
      'Im Block liegen noch Rufnummern. Löschen Sie diese zuerst:',

    'trunks.subtitle':
      'Die Verbindungen zu Ihren Telefonanbietern, über die Anrufe hinaus- und hereinkommen.',
    'trunks.add': 'Trunk hinzufügen',
    'trunks.addSubtitle':
      'Verbinden Sie die Telefonanlage mit einem Anbieter. Die Zugangsdaten stehen in den Unterlagen Ihres Anbieters.',
    'trunks.empty': 'Noch kein Trunk',
    'trunks.emptyBody':
      'Ohne Trunk gibt es keine Anrufe nach draußen. Der erste Trunk bekommt automatisch eine Route für alle Anrufe.',
    'trunks.notFound': 'Diesen Trunk gibt es nicht (mehr)',
    'trunks.notFoundBody': 'Er wurde vielleicht gelöscht.',
    'trunks.routesHint':
      'Welche Anrufe über welchen Trunk gehen, legen Sie unter',
    'trunks.status.registered': 'angemeldet',
    'trunks.status.reachable': 'erreichbar',
    'trunks.status.unreachable': 'nicht erreichbar',
    'trunks.status.unmonitored': 'nicht überwacht',
    'trunks.status.unknown': 'unbekannt',
    'trunks.since': 'seit {when}',
    'trunks.statusSince': 'Status seit',
    'trunks.lastRegistered': 'Zuletzt angemeldet',
    'trunks.lastRegisteredAt': 'Zuletzt angemeldet: {at}',
    'trunks.channels': 'max. {count} Gespräche',
    'trunks.calls': 'Gespräche',
    'trunks.usedBy': 'Verwendet in',
    'trunks.routeCount': '{count} Route(n)',
    'trunks.emergencyBadge': 'Notrufe',
    'trunks.reregister': 'Neu anmelden',
    'trunks.reregistering': '{name} meldet sich neu an …',
    'trunks.open': 'Öffnen',
    'trunks.created': 'Trunk {name} angelegt',
    'trunks.saved': 'Trunk {name} gespeichert',
    'trunks.deleted': 'Trunk {name} gelöscht',
    'trunks.create': 'Trunk anlegen',
    'trunks.createHint':
      'Füllen Sie die Pflichtfelder aus und legen Sie den Trunk an.',
    'trunks.unsaved': 'Ungespeicherte Änderungen',
    'trunks.discard': 'Verwerfen',
    'trunks.saveBar': 'Speichern',
    'trunks.warning.noEmergency':
      'Kein Trunk ist für Notrufe freigegeben – Notrufe schlagen fehl.',
    'trunks.warning.srv':
      'Ein Host hat einen festen Port: Die automatische Serverauswahl (SRV) entfällt für ihn.',
    'trunks.section.basics': 'Anbieter & Anmeldung',
    'trunks.section.basicsBody':
      'Wie sich die Anlage mit Ihrem Anbieter verbindet.',
    'trunks.section.callerId': 'Rufnummernanzeige & Weiterleitungen',
    'trunks.section.callerIdBody':
      'Welche Nummer Angerufene sehen und wie Ihr Anbieter Nummern schickt.',
    'trunks.section.capacity': 'Kapazität',
    'trunks.section.capacityBody':
      'Wie viele Gespräche Ihr Anbieter gleichzeitig zulässt.',
    'trunks.section.expert': 'Technische Feinheiten',
    'trunks.section.expertBody':
      'SIP- und Medien-Einstellungen für besondere Anbieter und die Fehlersuche.',
    'trunks.namePlaceholder': 'z. B. Telekom SIP-Trunk',
    'trunks.emergencyYes': 'Ja, für Notrufe',
    'trunks.emergencyNo': 'Nein',
    'trunks.authMode.registration': 'Mit Benutzername & Passwort',
    'trunks.authMode.registrationBody':
      'Die Anlage meldet sich beim Anbieter an. So arbeiten die meisten Anbieter.',
    'trunks.authMode.ip': 'Über die IP-Adresse',
    'trunks.authMode.ipBody':
      'Der Anbieter kennt die feste IP-Adresse der Anlage; es gibt keine Anmeldung.',
    'trunks.transportTls': 'TLS (verschlüsselt)',
    'trunks.direction.both': 'beide Richtungen',
    'trunks.direction.outbound': 'nur ausgehend',
    'trunks.direction.inbound': 'nur eingehend',
    'trunks.portAuto': 'Port (auto)',
    'trunks.registrar': 'Anmeldeserver',
    'trunks.portWarning':
      'Fester Port: keine automatische Serverauswahl (SRV).',
    'trunks.addHost': 'Host hinzufügen',
    'trunks.header.from': 'Im Absender (From)',
    'trunks.header.fromBody':
      'Die angezeigte Nummer steht im Absender. Der Normalfall.',
    'trunks.header.pai': 'In P-Asserted-Identity',
    'trunks.header.paiBody':
      'Absender ist Ihr Konto, die Nummer steht in P-Asserted-Identity. Braucht einen Benutzernamen.',
    'trunks.header.both': 'In beiden',
    'trunks.header.bothBody':
      'Die Nummer steht im Absender und in P-Asserted-Identity.',
    'trunks.format.e164': 'International (+49 …)',
    'trunks.format.national': 'National (089 …)',
    'trunks.clir.inherit': 'Wie die Firma ({value})',
    'trunks.clir.show': 'anzeigen',
    'trunks.clir.withhold': 'unterdrücken',
    'trunks.clir.needsPai':
      'Unterdrücken geht nur, wenn die Nummer in P-Asserted-Identity steht (Rufnummernanzeige oben).',
    'trunks.diversion.off': 'Nicht mitsenden',
    'trunks.diversion.last': 'Letzte Weiterleitung',
    'trunks.diversion.all': 'Alle Weiterleitungen',
    'trunks.forwarded.own': 'Ihre Nummer',
    'trunks.forwarded.ownBody':
      'Weitergeleitete Anrufe zeigen die Nummer der Firma.',
    'trunks.forwarded.original': 'Nummer des Anrufers',
    'trunks.forwarded.originalBody':
      'Zeigt, wer ursprünglich anruft; Ihre Nummer geht in P-Asserted-Identity mit.',
    'trunks.forwarded.originalPreferred': 'Nummer des Anrufers (PPI)',
    'trunks.forwarded.originalPreferredBody':
      'Wie „Nummer des Anrufers“, Ihre Nummer aber in P-Preferred-Identity – für Anbieter, die das verlangen.',
    'trunks.forwarded.needs':
      'Die Nummer des Anrufers lässt sich nur zeigen, wenn die Nummer im Absender steht und Weiterleitungen mitgesendet werden.',
    'trunks.forwarded.display': 'sieht',
    'trunks.forwarded.explainOwn':
      'Wer einen weitergeleiteten Anruf auf dem Handy annimmt, sieht Ihre Firmennummer – nicht, wer eigentlich anruft.',
    'trunks.forwarded.explainOriginal':
      'Das Ziel der Weiterleitung sieht die Nummer des ursprünglichen Anrufers. Anbieter verkaufen das als „CLIP no screening“: Ihre eigene Nummer reist unsichtbar im Netz mit, angezeigt wird die des Anrufers. Buchen Sie die Option bei Ihrem Anbieter – ohne sie zeigt er Ihre Nummer an oder lehnt den Anruf ab.',
    'trunks.inboundAuthSwitch': 'Anrufe des Anbieters mit Passwort prüfen',
    'trunks.srtpSwitch': 'Gespräche verschlüsseln (SRTP)',
    'trunks.srtpNeedsTls': 'Nur mit TLS möglich.',
    'trunks.tlsVerifySwitch': 'Zertifikat des Anbieters prüfen',
    'trunks.onlyTls': 'Wirkt nur bei TLS.',
    'trunks.qualifySwitch': 'Erreichbarkeit überwachen',
    'trunks.onlyIp': 'Wirkt nur bei IP-Anmeldung.',
    'trunks.codecsTenant': 'Codecs der Firma verwenden',
    'trunks.addCodec': 'Codec hinzufügen …',
    'trunks.order.title': 'Reihenfolge für Notrufe',
    'trunks.order.body':
      'Notrufe gehen nur über freigegebene Trunks, in dieser Reihenfolge; ein nicht erreichbarer wird übersprungen.',
    'trunks.order.save': 'Reihenfolge speichern',
    'trunks.order.notEmergency': 'nicht für Notrufe',
    'trunks.orderSaved': 'Reihenfolge gespeichert',

    'field.trunk.name': 'Name',
    'field.trunk.emergency': 'Notrufe über diesen Trunk',
    'field.trunk.emergency.help':
      'Nur wenn der Anbieter Notrufe an die Notrufzentrale Ihres Firmenstandorts leitet – ein Anbieter im Ausland kann das nicht.',
    'field.trunk.authMode': 'Anmeldung beim Anbieter',
    'field.trunk.username': 'Benutzername',
    'field.trunk.username.help':
      'Der Kontoname beim Anbieter, z. B. Ihre Rufnummer oder eine Kundenkennung.',
    'field.trunk.password': 'Passwort',
    'field.trunk.password.help':
      'Wird sicher gespeichert und nie wieder angezeigt. Eine Änderung lässt sich nicht rückgängig machen.',
    'field.trunk.hosts': 'Server des Anbieters',
    'field.trunk.hosts.help':
      'In der Reihenfolge, in der sie versucht werden. Hostname oder IPv4-Adresse; „nur eingehend“ (eine Absenderadresse des Anbieters) darf auch IPv6 oder ein Bereich (CIDR) sein. Port nur angeben, wenn der Anbieter es verlangt.',
    'field.trunk.transport': 'Verbindung',
    'field.trunk.transport.help':
      'TLS verschlüsselt Anmeldung und Rufaufbau; wählen Sie es, wenn Ihr Anbieter es unterstützt.',
    'field.trunk.inboundNumberFormat': 'Format eingehender Nummern',
    'field.trunk.inboundNumberFormat.help':
      'Wie der Anbieter Nummern schickt. Bei „National“ wird 089 … zu +4989 ….',
    'field.trunk.callerIdFormat': 'Format der angezeigten Nummer',
    'field.trunk.callerIdFormat.help': 'Wie Ihre Nummer an den Anbieter geht.',
    'field.trunk.callerIdHeader': 'Wo die angezeigte Nummer steht',
    'field.trunk.clir': 'Nummer unterdrücken',
    'field.trunk.clir.help':
      'Gilt für Anrufe über diesen Trunk, sofern die Person nichts anderes eingestellt hat. Notrufe zeigen immer die Nummer.',
    'field.trunk.diversion': 'Weiterleitung mitsenden (Diversion)',
    'field.trunk.diversion.help':
      'Ob ein weitergeleiteter Anruf dem Ziel sagt, wer ihn weitergeleitet hat.',
    'field.trunk.forwardedCallerId': 'Angezeigte Nummer bei Weiterleitungen',
    'field.trunk.maxChannels': 'Gleichzeitige Gespräche',
    'field.trunk.maxChannels.help':
      'So viele Gespräche, wie Ihr Tarif erlaubt; leer = unbegrenzt. Ist der Trunk voll, nimmt ein Anruf die nächste passende Route.',
    'field.trunk.inboundAuth': 'Eingehende Anrufe authentifizieren',
    'field.trunk.inboundAuth.help':
      'Die Anlage verlangt vom Anbieter Benutzername und Passwort und erkennt den Trunk daran – dann braucht er keine eingehenden Server.',
    'field.trunk.srtp': 'SRTP',
    'field.trunk.srtp.help':
      'Verschlüsselt die Sprache (SDES-SRTP), falls der Anbieter das verlangt.',
    'field.trunk.tlsVerify': 'Zertifikatsprüfung',
    'field.trunk.tlsVerify.help':
      'Ausschalten nur bei einem selbst signierten Zertifikat des Anbieters.',
    'field.trunk.qualify': 'Erreichbarkeit (OPTIONS)',
    'field.trunk.qualify.help':
      'Fragt jede Minute beim ersten Server nach. Für Gegenstellen, die nicht antworten, ausschalten – der Trunk gilt dann als „nicht überwacht“ und wird immer versucht.',
    'field.trunk.outboundProxy': 'Outbound-Proxy',
    'field.trunk.outboundProxy.help':
      'Eine sip:- oder sips:-Adresse, über die alles läuft, z. B. sip:proxy.example.com; der Zusatz ;lr wird automatisch ergänzt.',
    'field.trunk.registerExpiryS': 'Anmeldedauer',
    'field.trunk.registerExpiryS.help':
      'Wie lange eine Anmeldung gilt, in Sekunden.',
    'field.trunk.registerRetryS': 'Erneuter Versuch nach',
    'field.trunk.registerRetryS.help':
      'Sekunden bis zum nächsten Anmeldeversuch nach einem Fehler.',
    'field.trunk.codecs': 'Codecs',
    'field.trunk.codecs.help':
      'Die angebotenen Audio-Codecs in dieser Reihenfolge; die Anlage übersetzt bei Bedarf.',
    'field.trunk.logLevel': 'Diagnosestufe',
    'field.trunk.logLevelExpiresAt': 'Diagnose bis',
    'field.trunkOrder.trunkIds': 'Reihenfolge für Notrufe',

    'confirm.trunks.delete.title': 'Trunk löschen?',
    'confirm.trunks.delete.body':
      'Über „{name}“ gehen danach keine Anrufe mehr. Sie können das Löschen {days} Tage lang rückgängig machen.',
    'confirm.trunks.delete.action': 'Löschen',
    'confirm.trunks.delete.anyTime.title': 'Trunk löschen?',
    'confirm.trunks.delete.anyTime.body':
      'Über „{name}“ gehen danach keine Anrufe mehr. Sie können das Löschen jederzeit rückgängig machen.',
    'confirm.trunks.delete.anyTime.action': 'Löschen',

    'errors.trunks.invalidValue': 'Ungültiger Wert für {field}.',
    'errors.trunks.nameRequired': 'Bitte einen Namen eingeben.',
    'errors.trunks.nameTaken': 'Einen Trunk mit diesem Namen gibt es schon:',
    'errors.trunks.emergencyRequired':
      'Bitte festlegen, ob dieser Trunk Notrufe trägt.',
    'errors.trunks.transportDisabled':
      '{transport} ist auf dieser Anlage abgeschaltet. Bitte TLS wählen.',
    'errors.trunks.hostsRequired': 'Bitte mindestens einen Server angeben.',
    'errors.trunks.hostRequired':
      'Bitte jeden Server ausfüllen oder entfernen.',
    'errors.trunks.hostUnsafe': '„{host}“ enthält unzulässige Zeichen.',
    'errors.trunks.hostInvalid':
      '„{host}“ ist kein Hostname und keine IPv4-Adresse. IPv6 und Bereiche gehen nur bei „nur eingehend“.',
    'errors.trunks.hostInvalidInbound':
      '„{host}“ ist kein Hostname, keine IP-Adresse und kein Bereich (CIDR).',
    'errors.trunks.portRange':
      'Der Port von „{host}“ muss zwischen 1 und 65535 liegen.',
    'errors.trunks.noRegistrar':
      'Zum Anmelden braucht es einen Server mit „beide Richtungen“ oder „nur ausgehend“.',
    'errors.trunks.srtpNeedsTls': 'SRTP geht nur über eine TLS-Verbindung.',
    'errors.trunks.clirNeedsPai':
      'Unterdrücken braucht die Nummer in P-Asserted-Identity („In P-Asserted-Identity“ oder „In beiden“).',
    'errors.trunks.forwardedNeedsFrom':
      'Die Nummer des Anrufers lässt sich nur zeigen, wenn die Nummer im Absender (From) steht.',
    'errors.trunks.forwardedNeedsDiversion':
      'Die Nummer des Anrufers braucht „Weiterleitung mitsenden“ – sonst erkennt der Anbieter die Weiterleitung nicht.',
    'errors.trunks.credentialsRequired':
      'Für diese Anmeldung braucht es Benutzername und Passwort.',
    'errors.trunks.credentialsNotAccepted':
      'Benutzername und Passwort gibt es nur bei Anmeldung mit Passwort oder geprüften eingehenden Anrufen.',
    'errors.trunks.registrationOnly':
      'Anmeldedauer und Wiederholung gibt es nur bei Anmeldung mit Passwort.',
    'errors.trunks.paiNeedsUsername':
      'P-Asserted-Identity braucht einen Benutzernamen – er steht dann im Absender.',
    'errors.trunks.usernameInvalid':
      'Der Benutzername enthält ein Zeichen, das in einer SIP-Adresse nicht vorkommen darf.',
    'errors.trunks.passwordInvalid':
      'Das Passwort darf keine Zeilenumbrüche enthalten und nicht mit Leerzeichen beginnen oder enden.',
    'errors.trunks.inboundAuthUsername':
      'Dieser Benutzername taugt nicht für geprüfte eingehende Anrufe (kein „;“, nicht „trunk-…“ oder „anonymous“, höchstens {max} Zeichen).',
    'errors.trunks.usernameTaken':
      'Dieser Benutzername gehört schon zu einem anderen Telefon oder Trunk:',
    'errors.trunks.codecsInvalid': 'Bitte mindestens einen Codec wählen.',
    'errors.trunks.maxChannelsRange':
      'Bitte eine Zahl ab 1 eingeben – oder leer lassen für unbegrenzt.',
    'errors.trunks.outboundProxyInvalid':
      'Bitte eine sip:- oder sips:-Adresse eingeben, z. B. sip:proxy.example.com.',
    'errors.trunks.secondsRange': 'Bitte 1 bis {max} Sekunden angeben.',
    'errors.trunks.logLevelExpiry':
      'Ein Ablaufdatum braucht eine Diagnosestufe.',
    'errors.trunks.inUse': 'Der Trunk wird noch verwendet von:',
    'errors.trunks.orderMismatch':
      'Die Reihenfolge muss jeden Trunk genau einmal enthalten. Bitte neu laden.',
    'errors.trunks.noRegistration':
      'Dieser Trunk meldet sich nicht an (IP-Anmeldung).',

    'outboundRoutes.subtitle':
      'Über welchen Trunk Anrufe nach draußen gehen und welche Nummer Angerufene sehen.',
    'outboundRoutes.add': 'Route hinzufügen',
    'outboundRoutes.save': 'Reihenfolge & Routen speichern',
    'outboundRoutes.saved': 'Routen gespeichert',
    'outboundRoutes.unsaved':
      'Änderungen an Routen und Reihenfolge sind noch nicht gespeichert.',
    'outboundRoutes.empty': 'Keine Routen',
    'outboundRoutes.emptyBody':
      'Ohne Route werden alle Anrufe nach draußen abgewiesen. Legen Sie mindestens eine Route für alle an.',
    'outboundRoutes.position': 'Route {position}',
    'outboundRoutes.summary':
      '{who} → {what} über {trunk}, angezeigt wird {shows}',
    'outboundRoutes.everyone': 'Alle',
    'outboundRoutes.everyoneLong':
      'Alle – auch Anrufe, die die Anlage selbst weiterleitet.',
    'outboundRoutes.anyNumber': 'jede Nummer',
    'outboundRoutes.anyNumberLong': 'Jede Nummer.',
    'outboundRoutes.theirOwnNumber': 'die eigene Nummer',
    'outboundRoutes.callerIdOwn':
      'Eigene Nummer der Person (sonst Hauptnummer)',
    'outboundRoutes.trunkGone': '(gelöschter Trunk)',
    'outboundRoutes.catchAll': 'Für alle Anrufe',
    'outboundRoutes.new': 'neu',
    'outboundRoutes.remove': 'Route entfernen',
    'outboundRoutes.startsWith': 'beginnt mit',
    'outboundRoutes.exactly': 'genau',
    'outboundRoutes.prefixSwitch': 'Alle Nummern, die so beginnen',
    'outboundRoutes.thenNext': 'passt nicht oder Trunk nicht verfügbar ↓',
    'outboundRoutes.catchAllNotLast':
      'Route {position} passt auf alle Anrufe. Die Routen darunter kommen nur zum Zug, wenn deren Trunk nicht verfügbar ist.',
    'outboundRoutes.noCatchAll':
      'Unten fehlt eine Route für alle Anrufe. Anrufe, auf die keine Route passt, werden abgewiesen.',
    'outboundRoutes.how.title': 'So wird geroutet',
    'outboundRoutes.how.order':
      'Die Routen werden von oben nach unten geprüft.',
    'outboundRoutes.how.match':
      'Die erste Route, bei der Person und gewählte Nummer passen, gewinnt. Eine leere Liste passt auf alles.',
    'outboundRoutes.how.fallthrough':
      'Kann ihr Trunk den Anruf nicht übernehmen, geht es mit der nächsten passenden Route weiter:',
    'outboundRoutes.how.unreachable': 'Trunk nicht erreichbar,',
    'outboundRoutes.how.channels': 'alle Gesprächskanäle belegt,',
    'outboundRoutes.how.refused': 'der Anbieter lehnt ab, bevor es klingelt,',
    'outboundRoutes.how.clir':
      'die Nummer soll unterdrückt werden, aber der Trunk kann es nicht.',
    'outboundRoutes.how.catchAll':
      'Lassen Sie unten eine Route für alle Anrufe als Standard stehen.',
    'outboundRoutes.how.emergency':
      'Notrufe folgen keiner Route, sondern der Notruf-Reihenfolge unter',

    'field.outboundRoute.routes': 'Routen',
    'field.outboundRoute.trunkId': 'Über Trunk',
    'field.outboundRoute.trunkId.help': 'Der Anbieter, der den Anruf trägt.',
    'field.outboundRoute.callerIdDidId': 'Angezeigte Nummer',
    'field.outboundRoute.callerIdDidId.help':
      'Geht vor der eigenen Nummer der Person und der Hauptnummer.',
    'field.outboundRoute.users': 'Wer',
    'field.outboundRoute.numbers': 'Gewählte Nummern',

    'errors.outboundRoutes.duplicateUser':
      'Eine Person steht doppelt in einer Route.',
    'errors.outboundRoutes.duplicateGroup':
      'Eine Gruppe steht doppelt in einer Route.',
    'errors.outboundRoutes.numberE164':
      '„{number}“ ist keine internationale Nummer (z. B. +43 oder +4989123).',
    'errors.outboundRoutes.duplicateNumber':
      'Eine Nummer steht doppelt in einer Route.',
    'errors.outboundRoutes.trunkUnknown':
      'Eine Route nutzt einen Trunk, den es nicht mehr gibt.',
    'errors.outboundRoutes.didUnknown':
      'Eine Route zeigt eine Nummer an, die es nicht mehr gibt.',
    'errors.outboundRoutes.didNotNumeric':
      '„{number}“ ist keine Rufnummer und kann nicht angezeigt werden.',
    'errors.outboundRoutes.callerUnknown':
      'Eine Route nennt eine Person oder Gruppe, die es nicht gibt.',
    'errors.outboundRoutes.duplicateRoute':
      'Eine Route steht doppelt in der Liste.',
    'errors.outboundRoutes.routeUnknown':
      'Eine Route gibt es nicht mehr. Bitte neu laden.'
  },
  en: {
    'numbers.subtitle': "The company's phone numbers and where their calls go.",
    'numbers.tab.numbers': 'Numbers',
    'numbers.tab.blocks': 'Number blocks',
    'numbers.add': 'Add number',
    'numbers.addSubtitle': 'A phone number your provider assigned to you.',
    'numbers.editSubtitle': 'Phone number',
    'numbers.mainNumber': 'Main number',
    'numbers.mainBadge': 'Main number',
    'numbers.mainNumberNote':
      'Shown on outgoing calls when neither the route nor the person sets a number of their own.',
    'numbers.mainNumberChange': 'Change in Settings',
    'numbers.callsGoTo': 'Calls go to',
    'numbers.block': 'Block',
    'numbers.callerIdOf': 'caller ID ×{count}',
    'numbers.callerIdOfRoutes': 'caller ID in {count} route(s)',
    'numbers.verbatim': 'provider identifier',
    'numbers.storedAs': 'Saved as',
    'numbers.storedVerbatim':
      'Not a phone number – matched exactly as written:',
    'numbers.inBlock': 'Belongs to the number block “{block}”.',
    'numbers.labelPlaceholder': 'e.g. reception, hotline',
    'numbers.empty': 'No numbers yet',
    'numbers.emptyBody':
      'Add the numbers your provider assigned to you and decide who answers them.',
    'numbers.created': '{number} added',
    'numbers.updated': 'Target of {number} saved',
    'numbers.deleted': '{number} deleted',

    'numbers.addBlock': 'Add number block',
    'numbers.addBlockSubtitle':
      'A range of direct dials, e.g. 089 4520 0 to 999.',
    'numbers.blocksIntro':
      'A number block groups the direct-dial numbers of a line. A call to a number in the block that is not assigned to anyone goes to the fallback – numbers in the block are never treated as internal extensions.',
    'numbers.blocksEmpty': 'No number blocks',
    'numbers.blocksEmptyBody':
      'Add a block when your line comes with a range of direct dials.',
    'numbers.digitsFixed': 'Fixed length',
    'numbers.digitsOpen': 'Any length',
    'numbers.digitsSuffix': 'digits',
    'numbers.blockHolds': '{count} numbers',
    'numbers.patternPreview': 'Pattern',
    'numbers.blockLabelPlaceholder': 'e.g. Munich line',
    'numbers.companyFallback': 'Company-wide fallback',
    'numbers.companyFallbackIs': 'Currently:',
    'numbers.noFallback': 'none – the call is refused',
    'numbers.openEnded': 'any number of digits',
    'numbers.digitsSummary': '{digits} digits · {count} numbers',
    'numbers.assigned': 'Assigned',
    'numbers.assignedOf': '{count} of {total}',
    'numbers.blockNoNumbers': 'No number in this block yet.',
    'numbers.blockCreated': 'Number block added',
    'numbers.blockUpdated': 'Number block saved',
    'numbers.blockDeleted': 'Number block deleted',

    'field.did.number': 'Number',
    'field.did.number.help':
      'As you know it, e.g. 089 4520 155 or +49 89 4520 155. Cannot be changed later.',
    'field.did.label': 'Label',
    'field.did.label.help':
      'For your orientation; set when the number is added.',
    'field.did.target': 'Calls go to',
    'field.did.target.help':
      'Who or what answers. A person without a caller ID of their own gets this number as their caller ID.',
    'field.didBlock.base': 'Starts with',
    'field.didBlock.base.help':
      'What every number in the block starts with, e.g. 089 4520. Cannot be changed later.',
    'field.didBlock.label': 'Label',
    'field.didBlock.digits': 'Digits after it',
    'field.didBlock.digits.help':
      'How many digits follow, e.g. 3 for 089 4520 xxx. “Any length” covers every number that starts like this.',
    'field.didBlock.fallbackTarget': 'Fallback',
    'field.didBlock.fallbackTarget.help':
      'Where calls for unassigned numbers in the block go – an announcement works well.',

    'confirm.dids.delete.title': 'Delete number?',
    'confirm.dids.delete.body':
      '{number} takes no more calls afterwards. You can undo the deletion for {days} days.',
    'confirm.dids.delete.action': 'Delete',
    'confirm.dids.delete.anyTime.title': 'Delete number?',
    'confirm.dids.delete.anyTime.body':
      '{number} takes no more calls afterwards. You can undo the deletion at any time.',
    'confirm.dids.delete.anyTime.action': 'Delete',
    'confirm.didBlocks.delete.title': 'Delete number block?',
    'confirm.didBlocks.delete.body':
      'The block {base} and its fallback are removed. You can undo the deletion for {days} days.',
    'confirm.didBlocks.delete.action': 'Delete',
    'confirm.didBlocks.delete.anyTime.title': 'Delete number block?',
    'confirm.didBlocks.delete.anyTime.body':
      'The block {base} and its fallback are removed. You can undo the deletion at any time.',
    'confirm.didBlocks.delete.anyTime.action': 'Delete',

    'errors.numbers.numberRequired': 'Please enter a number.',
    'errors.numbers.numberWhitespace':
      'Please enter it without spaces, e.g. 0894520155.',
    'errors.numbers.numberTaken': 'This number already exists:',
    'errors.numbers.baseTaken': 'A block with this start already exists:',
    'errors.numbers.baseWildcard':
      'The start cannot contain wildcards (* ? [ ]).',
    'errors.numbers.digitsRange': 'Please enter at least 1 digit.',
    'errors.numbers.targetExternal':
      'The external number must be international, e.g. +4917155501234.',
    'errors.numbers.targetSipUser':
      'The SIP user may only contain A–Z, a–z, 0–9 and . _ ~ + - (1–64 characters).',
    'errors.numbers.mainNumber':
      "This is the company's main number. Choose another main number first:",
    'errors.numbers.callerIdOfUsers': 'This number is still the caller ID of:',
    'errors.numbers.callerIdOfRoutes':
      'Outbound routes still present this number:',
    'errors.numbers.blockHasNumbers':
      'Numbers still fall within the block. Delete them first:',

    'trunks.subtitle':
      'The connections to your phone providers that carry your outside calls.',
    'trunks.add': 'Add trunk',
    'trunks.addSubtitle':
      "Connect the phone system to a provider. You'll find the access details in your provider's documents.",
    'trunks.empty': 'No trunk yet',
    'trunks.emptyBody':
      'Without a trunk there are no outside calls. The first trunk automatically gets a route for every call.',
    'trunks.notFound': 'This trunk does not exist (any more)',
    'trunks.notFoundBody': 'It may have been deleted.',
    'trunks.routesHint': 'Which calls take which trunk is set under',
    'trunks.status.registered': 'registered',
    'trunks.status.reachable': 'reachable',
    'trunks.status.unreachable': 'unreachable',
    'trunks.status.unmonitored': 'unmonitored',
    'trunks.status.unknown': 'unknown',
    'trunks.since': 'since {when}',
    'trunks.statusSince': 'Status since',
    'trunks.lastRegistered': 'Last registered',
    'trunks.lastRegisteredAt': 'Last registered: {at}',
    'trunks.channels': 'max. {count} calls',
    'trunks.calls': 'calls',
    'trunks.usedBy': 'Used in',
    'trunks.routeCount': '{count} route(s)',
    'trunks.emergencyBadge': 'Emergency calls',
    'trunks.reregister': 'Re-register',
    'trunks.reregistering': '{name} is re-registering …',
    'trunks.open': 'Open',
    'trunks.created': 'Trunk {name} created',
    'trunks.saved': 'Trunk {name} saved',
    'trunks.deleted': 'Trunk {name} deleted',
    'trunks.create': 'Create trunk',
    'trunks.createHint': 'Fill in the required fields and create the trunk.',
    'trunks.unsaved': 'Unsaved changes',
    'trunks.discard': 'Discard',
    'trunks.saveBar': 'Save',
    'trunks.warning.noEmergency':
      'No trunk carries emergency calls – emergency calls will fail.',
    'trunks.warning.srv':
      'A host has a fixed port: automatic server selection (SRV) is skipped for it.',
    'trunks.section.basics': 'Provider & sign-in',
    'trunks.section.basicsBody':
      'How the phone system connects to your provider.',
    'trunks.section.callerId': 'Caller ID & forwarding',
    'trunks.section.callerIdBody':
      'Which number the people you call see, and how your provider sends numbers.',
    'trunks.section.capacity': 'Capacity',
    'trunks.section.capacityBody':
      'How many calls your provider allows at the same time.',
    'trunks.section.expert': 'Technical details',
    'trunks.section.expertBody':
      'SIP and media settings for special providers and troubleshooting.',
    'trunks.namePlaceholder': 'e.g. Telekom SIP trunk',
    'trunks.emergencyYes': 'Yes, for emergency calls',
    'trunks.emergencyNo': 'No',
    'trunks.authMode.registration': 'With username & password',
    'trunks.authMode.registrationBody':
      'The phone system signs in with the provider. Most providers work like this.',
    'trunks.authMode.ip': 'By IP address',
    'trunks.authMode.ipBody':
      "The provider knows the phone system's fixed IP address; no sign-in is needed.",
    'trunks.transportTls': 'TLS (encrypted)',
    'trunks.direction.both': 'both ways',
    'trunks.direction.outbound': 'outbound only',
    'trunks.direction.inbound': 'inbound only',
    'trunks.portAuto': 'Port (auto)',
    'trunks.registrar': 'Registrar',
    'trunks.portWarning': 'Fixed port: no automatic server selection (SRV).',
    'trunks.addHost': 'Add host',
    'trunks.header.from': 'In the sender (From)',
    'trunks.header.fromBody':
      'The shown number is the sender. The usual setup.',
    'trunks.header.pai': 'In P-Asserted-Identity',
    'trunks.header.paiBody':
      'The sender is your account, the number goes in P-Asserted-Identity. Needs a username.',
    'trunks.header.both': 'In both',
    'trunks.header.bothBody':
      'The number is the sender and goes in P-Asserted-Identity too.',
    'trunks.format.e164': 'International (+49 …)',
    'trunks.format.national': 'National (089 …)',
    'trunks.clir.inherit': 'Like the company ({value})',
    'trunks.clir.show': 'show',
    'trunks.clir.withhold': 'withhold',
    'trunks.clir.needsPai':
      'Withholding needs the number in P-Asserted-Identity (caller ID above).',
    'trunks.diversion.off': "Don't send",
    'trunks.diversion.last': 'Last forward',
    'trunks.diversion.all': 'All forwards',
    'trunks.forwarded.own': 'Your number',
    'trunks.forwarded.ownBody': "Forwarded calls show the company's number.",
    'trunks.forwarded.original': "Caller's number",
    'trunks.forwarded.originalBody':
      'Shows who originally called; your number travels along in P-Asserted-Identity.',
    'trunks.forwarded.originalPreferred': "Caller's number (PPI)",
    'trunks.forwarded.originalPreferredBody':
      "Like “Caller's number”, but your number goes in P-Preferred-Identity – for providers that require it.",
    'trunks.forwarded.needs':
      "The caller's number can only be shown when the number is the sender and forwards are sent along.",
    'trunks.forwarded.display': 'sees',
    'trunks.forwarded.explainOwn':
      'Whoever answers a forwarded call on their mobile sees your company number – not who is actually calling.',
    'trunks.forwarded.explainOriginal':
      "The forwarding target sees the original caller's number. Providers sell this as “CLIP no screening”: your own number travels invisibly through the network while the caller's is displayed. Book the option with your provider – without it they show your number or refuse the call.",
    'trunks.inboundAuthSwitch': "Verify the provider's calls with a password",
    'trunks.srtpSwitch': 'Encrypt calls (SRTP)',
    'trunks.srtpNeedsTls': 'Only with TLS.',
    'trunks.tlsVerifySwitch': "Check the provider's certificate",
    'trunks.onlyTls': 'Applies to TLS only.',
    'trunks.qualifySwitch': 'Monitor reachability',
    'trunks.onlyIp': 'Applies to IP sign-in only.',
    'trunks.codecsTenant': "Use the company's codecs",
    'trunks.addCodec': 'Add codec …',
    'trunks.order.title': 'Order for emergency calls',
    'trunks.order.body':
      'Emergency calls take only trunks enabled for them, in this order; an unreachable one is skipped.',
    'trunks.order.save': 'Save order',
    'trunks.order.notEmergency': 'not for emergency calls',
    'trunks.orderSaved': 'Order saved',

    'field.trunk.name': 'Name',
    'field.trunk.emergency': 'Emergency calls over this trunk',
    'field.trunk.emergency.help':
      "Only when the provider routes emergency calls to the emergency centre of your company's address – a provider abroad cannot.",
    'field.trunk.authMode': 'Sign-in with the provider',
    'field.trunk.username': 'Username',
    'field.trunk.username.help':
      'Your account name with the provider, e.g. your phone number or a customer ID.',
    'field.trunk.password': 'Password',
    'field.trunk.password.help':
      'Stored securely and never shown again. A change cannot be undone.',
    'field.trunk.hosts': "Provider's servers",
    'field.trunk.hosts.help':
      'In the order they are tried. A host name or IPv4 address; “inbound only” (an address the provider sends from) may also be IPv6 or a range (CIDR). Give a port only where the provider requires one.',
    'field.trunk.transport': 'Connection',
    'field.trunk.transport.help':
      'TLS encrypts sign-in and call setup; choose it if your provider supports it.',
    'field.trunk.inboundNumberFormat': 'Format of incoming numbers',
    'field.trunk.inboundNumberFormat.help':
      'How the provider sends numbers. With “National”, 089 … becomes +4989 ….',
    'field.trunk.callerIdFormat': 'Format of the shown number',
    'field.trunk.callerIdFormat.help':
      'How your number is sent to the provider.',
    'field.trunk.callerIdHeader': 'Where the shown number goes',
    'field.trunk.clir': 'Withhold number',
    'field.trunk.clir.help':
      'Applies to calls over this trunk unless the person set otherwise. Emergency calls always show the number.',
    'field.trunk.diversion': 'Send forwarding (Diversion)',
    'field.trunk.diversion.help':
      'Whether a forwarded call tells its target who forwarded it.',
    'field.trunk.forwardedCallerId': 'Number shown on forwarded calls',
    'field.trunk.maxChannels': 'Concurrent calls',
    'field.trunk.maxChannels.help':
      'As many calls as your plan allows; empty = unlimited. When the trunk is full, a call takes the next matching route.',
    'field.trunk.inboundAuth': 'Authenticate incoming calls',
    'field.trunk.inboundAuth.help':
      'The phone system asks the provider for username and password and recognises the trunk by them – it then needs no inbound-only servers.',
    'field.trunk.srtp': 'SRTP',
    'field.trunk.srtp.help':
      'Encrypts the audio (SDES-SRTP) where the provider requires it.',
    'field.trunk.tlsVerify': 'Certificate check',
    'field.trunk.tlsVerify.help':
      "Turn off only for a provider's self-signed certificate.",
    'field.trunk.qualify': 'Reachability (OPTIONS)',
    'field.trunk.qualify.help':
      'Checks the first server every minute. Turn off for a provider that does not respond – the trunk then shows as “unmonitored” and is always tried.',
    'field.trunk.outboundProxy': 'Outbound proxy',
    'field.trunk.outboundProxy.help':
      'A sip: or sips: address all traffic goes through, e.g. sip:proxy.example.com; the ;lr parameter is added automatically.',
    'field.trunk.registerExpiryS': 'Registration expiry',
    'field.trunk.registerExpiryS.help':
      'How long a registration lasts, in seconds.',
    'field.trunk.registerRetryS': 'Retry after',
    'field.trunk.registerRetryS.help':
      'Seconds until the next registration attempt after a failure.',
    'field.trunk.codecs': 'Codecs',
    'field.trunk.codecs.help':
      'The audio codecs offered, in this order; the phone system transcodes where needed.',
    'field.trunk.logLevel': 'Diagnostics level',
    'field.trunk.logLevelExpiresAt': 'Diagnostics until',
    'field.trunkOrder.trunkIds': 'Order for emergency calls',

    'confirm.trunks.delete.title': 'Delete trunk?',
    'confirm.trunks.delete.body':
      'No calls go through “{name}” afterwards. You can undo the deletion for {days} days.',
    'confirm.trunks.delete.action': 'Delete',
    'confirm.trunks.delete.anyTime.title': 'Delete trunk?',
    'confirm.trunks.delete.anyTime.body':
      'No calls go through “{name}” afterwards. You can undo the deletion at any time.',
    'confirm.trunks.delete.anyTime.action': 'Delete',

    'errors.trunks.invalidValue': 'Invalid value for {field}.',
    'errors.trunks.nameRequired': 'Please enter a name.',
    'errors.trunks.nameTaken': 'A trunk with this name already exists:',
    'errors.trunks.emergencyRequired':
      'Please decide whether this trunk carries emergency calls.',
    'errors.trunks.transportDisabled':
      '{transport} is switched off on this system. Please choose TLS.',
    'errors.trunks.hostsRequired': 'Please enter at least one server.',
    'errors.trunks.hostRequired': 'Please fill in or remove every server.',
    'errors.trunks.hostUnsafe':
      '“{host}” contains characters that are not allowed.',
    'errors.trunks.hostInvalid':
      '“{host}” is not a host name or IPv4 address. IPv6 and ranges are only allowed for “inbound only”.',
    'errors.trunks.hostInvalidInbound':
      '“{host}” is not a host name, IP address or range (CIDR).',
    'errors.trunks.portRange': 'The port of “{host}” must be 1 to 65535.',
    'errors.trunks.noRegistrar':
      'Signing in needs a server set to “both ways” or “outbound only”.',
    'errors.trunks.srtpNeedsTls': 'SRTP needs a TLS connection.',
    'errors.trunks.clirNeedsPai':
      'Withholding needs the number in P-Asserted-Identity (“In P-Asserted-Identity” or “In both”).',
    'errors.trunks.forwardedNeedsFrom':
      "The caller's number can only be shown when the number is the sender (From).",
    'errors.trunks.forwardedNeedsDiversion':
      "The caller's number needs “Send forwarding” – otherwise the provider cannot tell it is a forward.",
    'errors.trunks.credentialsRequired':
      'This sign-in needs a username and a password.',
    'errors.trunks.credentialsNotAccepted':
      'Username and password only apply to password sign-in or authenticated incoming calls.',
    'errors.trunks.registrationOnly':
      'Registration expiry and retry only apply to password sign-in.',
    'errors.trunks.paiNeedsUsername':
      'P-Asserted-Identity needs a username – it becomes the sender.',
    'errors.trunks.usernameInvalid':
      'The username contains a character a SIP address cannot hold.',
    'errors.trunks.passwordInvalid':
      'The password cannot contain line breaks or begin or end with a space.',
    'errors.trunks.inboundAuthUsername':
      'This username cannot be used for authenticated incoming calls (no “;”, not “trunk-…” or “anonymous”, at most {max} characters).',
    'errors.trunks.usernameTaken':
      'This username already belongs to another phone or trunk:',
    'errors.trunks.codecsInvalid': 'Please choose at least one codec.',
    'errors.trunks.maxChannelsRange':
      'Please enter 1 or more – or leave it empty for unlimited.',
    'errors.trunks.outboundProxyInvalid':
      'Please enter a sip: or sips: address, e.g. sip:proxy.example.com.',
    'errors.trunks.secondsRange': 'Please enter 1 to {max} seconds.',
    'errors.trunks.logLevelExpiry': 'An expiry needs a diagnostics level.',
    'errors.trunks.inUse': 'The trunk is still used by:',
    'errors.trunks.orderMismatch':
      'The order must name every trunk exactly once. Please reload.',
    'errors.trunks.noRegistration':
      'This trunk does not register (IP sign-in).',

    'outboundRoutes.subtitle':
      'Which trunk outgoing calls take and which number the people you call see.',
    'outboundRoutes.add': 'Add route',
    'outboundRoutes.save': 'Save order & routes',
    'outboundRoutes.saved': 'Routes saved',
    'outboundRoutes.unsaved':
      'Changes to the routes and their order are not saved yet.',
    'outboundRoutes.empty': 'No routes',
    'outboundRoutes.emptyBody':
      'Without a route every outgoing call is refused. Add at least one route for everyone.',
    'outboundRoutes.position': 'Route {position}',
    'outboundRoutes.summary': '{who} → {what} over {trunk}, showing {shows}',
    'outboundRoutes.everyone': 'Everyone',
    'outboundRoutes.everyoneLong':
      'Everyone – including calls the system forwards itself.',
    'outboundRoutes.anyNumber': 'any number',
    'outboundRoutes.anyNumberLong': 'Any number.',
    'outboundRoutes.theirOwnNumber': 'their own number',
    'outboundRoutes.callerIdOwn':
      "The person's own number (else the main number)",
    'outboundRoutes.trunkGone': '(deleted trunk)',
    'outboundRoutes.catchAll': 'For all calls',
    'outboundRoutes.new': 'new',
    'outboundRoutes.remove': 'Remove route',
    'outboundRoutes.startsWith': 'starts with',
    'outboundRoutes.exactly': 'exactly',
    'outboundRoutes.prefixSwitch': 'Every number that starts like this',
    'outboundRoutes.thenNext': 'no match or trunk unavailable ↓',
    'outboundRoutes.catchAllNotLast':
      'Route {position} matches every call. The routes below it only come into play when its trunk is unavailable.',
    'outboundRoutes.noCatchAll':
      'There is no route for every call at the bottom. Calls no route matches are refused.',
    'outboundRoutes.how.title': 'How routing works',
    'outboundRoutes.how.order': 'Routes are checked from top to bottom.',
    'outboundRoutes.how.match':
      'The first route where both the person and the dialled number match wins. An empty list matches everything.',
    'outboundRoutes.how.fallthrough':
      'When its trunk cannot take the call, the next matching route is tried:',
    'outboundRoutes.how.unreachable': 'the trunk is unreachable,',
    'outboundRoutes.how.channels': 'all its call channels are busy,',
    'outboundRoutes.how.refused': 'the provider refuses before anything rings,',
    'outboundRoutes.how.clir':
      'the number should be withheld but the trunk cannot.',
    'outboundRoutes.how.catchAll':
      'Keep a route for every call at the bottom as the default.',
    'outboundRoutes.how.emergency':
      'Emergency calls ignore routes and follow the emergency order under',

    'field.outboundRoute.routes': 'Routes',
    'field.outboundRoute.trunkId': 'Over trunk',
    'field.outboundRoute.trunkId.help': 'The provider that carries the call.',
    'field.outboundRoute.callerIdDidId': 'Shown number',
    'field.outboundRoute.callerIdDidId.help':
      "Takes precedence over the person's own number and the main number.",
    'field.outboundRoute.users': 'Who',
    'field.outboundRoute.numbers': 'Dialled numbers',

    'errors.outboundRoutes.duplicateUser': 'A person appears twice in a route.',
    'errors.outboundRoutes.duplicateGroup': 'A group appears twice in a route.',
    'errors.outboundRoutes.numberE164':
      '“{number}” is not an international number (e.g. +43 or +4989123).',
    'errors.outboundRoutes.duplicateNumber':
      'A number appears twice in a route.',
    'errors.outboundRoutes.trunkUnknown':
      'A route uses a trunk that no longer exists.',
    'errors.outboundRoutes.didUnknown':
      'A route shows a number that no longer exists.',
    'errors.outboundRoutes.didNotNumeric':
      '“{number}” is not a phone number and cannot be shown.',
    'errors.outboundRoutes.callerUnknown':
      'A route names a person or group that does not exist.',
    'errors.outboundRoutes.duplicateRoute':
      'A route appears twice in the list.',
    'errors.outboundRoutes.routeUnknown':
      'A route no longer exists. Please reload.'
  }
} satisfies Messages;
