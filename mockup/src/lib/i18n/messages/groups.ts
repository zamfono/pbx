/**
 * Ring groups, phone menus, the audio library, out of office and opening hours.
 */
import type { Messages } from '../index.svelte';

export default {
  de: {
    'groups.unsaved': 'Ungespeicherte Änderungen',

    'groups.rg.subtitle':
      'Mehrere Personen unter einer Durchwahl: gleichzeitig, der Reihe nach oder zufällig angerufen.',
    'groups.rg.add': 'Neue Rufgruppe',
    'groups.rg.addSub': 'Die Durchwahl wird automatisch vergeben.',
    'groups.rg.namePlaceholder': 'z. B. Empfang',
    'groups.rg.extAuto': 'Die nächste freie Durchwahl, automatisch vergeben.',
    'groups.rg.extShort': 'Durchwahl {ext}',
    'groups.rg.features': 'Ausstattung',
    'groups.rg.now': 'Gerade',
    'groups.rg.mailbox': 'Mailbox',
    'groups.rg.recording': 'Aufzeichnung',
    'groups.rg.music': 'Musik',
    'groups.rg.noMembers': 'Keine Mitglieder',
    'groups.rg.statusOpen': 'Erreichbar',
    'groups.rg.statusClosed': 'Geschlossen',
    'groups.rg.statusOoo': 'Abwesend',
    'groups.rg.empty': 'Noch keine Rufgruppen',
    'groups.rg.emptyBody':
      'Fassen Sie Kolleg:innen zusammen, damit Anrufe bei allen gleichzeitig oder der Reihe nach klingeln.',
    'groups.rg.notFound': 'Diese Rufgruppe gibt es nicht (mehr)',
    'groups.rg.notFoundBody': 'Vielleicht wurde sie gerade gelöscht.',
    'groups.rg.created': 'Rufgruppe {name} angelegt',
    'groups.rg.saved': 'Rufgruppe gespeichert',
    'groups.rg.deleted': 'Rufgruppe {name} gelöscht',
    'groups.rg.forwardingSaved': 'Weiterleitung gespeichert',
    'groups.rg.tab.settings': 'Einstellungen',
    'groups.rg.tab.forwarding': 'Weiterleitung',
    'groups.rg.tab.schedule': 'Zeiten & Abwesenheit',
    'groups.rg.strategy.simultaneous': 'Alle gleichzeitig',
    'groups.rg.strategy.simultaneous.desc':
      'Alle Telefone klingeln zugleich; wer zuerst abnimmt, hat das Gespräch.',
    'groups.rg.strategy.sequential': 'Der Reihe nach',
    'groups.rg.strategy.sequential.desc':
      'Eine Person nach der anderen, in der Reihenfolge der Mitglieder.',
    'groups.rg.strategy.random': 'Zufällig',
    'groups.rg.strategy.random.desc':
      'Eine Person nach der anderen, jedes Mal neu gemischt.',
    'groups.rg.cardGeneral': 'Allgemein',
    'groups.rg.cardRinging': 'Klingeln',
    'groups.rg.cardAudio': 'Begrüßung & Musik',
    'groups.rg.cardAudioDesc': 'Was Anrufende hören, bevor jemand abnimmt.',
    'groups.rg.cardMailbox': 'Mailbox & Aufzeichnung',
    'groups.rg.cardDiagnostics': 'Diagnose',
    'groups.rg.membersDesc':
      'Personen und Benutzergruppen, die bei Anrufen klingeln.',
    'groups.rg.membersOrdered':
      'Die Reihenfolge zählt: Ganz oben klingelt zuerst.',
    'groups.rg.reachedVia': 'Erreichbar über',
    'groups.rg.capOn': 'Gesamtdauer begrenzen',
    'groups.rg.capSimultaneous':
      'Gilt nur für „Der Reihe nach“ und „Zufällig“.',
    'groups.rg.skipBusyLabel': 'Wer telefoniert, wird übersprungen',
    'groups.rg.allowRejectLabel': 'Mitglieder dürfen Anrufe ablehnen',
    'groups.rg.noGreeting': 'Keine Begrüßung',
    'groups.rg.ringback': 'Normales Freizeichen',
    'groups.rg.standardGreeting': 'Standardansage',
    'groups.rg.toAudio': 'Audiodateien verwalten →',
    'groups.rg.mailboxLabel': 'Eigene Mailbox für die Gruppe',
    'groups.rg.recordLabel': 'Alle Gespräche der Gruppe aufzeichnen',
    'groups.rg.forwardingTitle': 'Wenn niemand rangeht',
    'groups.rg.forwardingDesc':
      'Wohin Anrufe gehen, die in der Gruppe niemand annimmt.',
    'groups.rg.condition.unanswered': 'Niemand nimmt ab',
    'groups.rg.condition.unanswered.desc':
      'Es hat geklingelt, aber niemand hat rechtzeitig abgenommen.',
    'groups.rg.condition.unavailable': 'Niemand ist erreichbar',
    'groups.rg.condition.unavailable.desc':
      'Kein Mitglied kann gerade klingeln, z. B. alle abgemeldet oder auf „Nicht stören“.',
    'groups.rg.ruleOn': 'Weiterleiten',
    'groups.rg.noUnansweredMailbox':
      'Ohne Regel landen Anrufe in der Mailbox der Gruppe.',
    'groups.rg.noUnansweredReject':
      'Ohne Regel und ohne Mailbox wird der Anruf abgewiesen.',
    'groups.rg.noUnavailable':
      'Ohne Regel gilt dasselbe wie bei „Niemand nimmt ab“.',

    'groups.menu.subtitle':
      'Ansage mit Tastenwahl: „Für die Buchhaltung drücken Sie die 2 …“',
    'groups.menu.add': 'Neues Sprachmenü',
    'groups.menu.addSub':
      'Ansage und Ausweichziel; die Tasten belegen Sie danach.',
    'groups.menu.addHint':
      'Nach dem Anlegen ordnen Sie den Tasten ihre Ziele zu.',
    'groups.menu.namePlaceholder': 'z. B. Hauptmenü',
    'groups.menu.noAnnouncements': 'Es gibt noch keine Ansage.',
    'groups.menu.keys': 'Tasten',
    'groups.menu.noKeys': 'Noch keine Taste belegt',
    'groups.menu.keyCount': '{count} Tasten belegt',
    'groups.menu.empty': 'Noch keine Sprachmenüs',
    'groups.menu.emptyBody':
      'Begrüßen Sie Anrufende mit einer Ansage und lassen Sie sie per Taste wählen.',
    'groups.menu.notFound': 'Dieses Sprachmenü gibt es nicht (mehr)',
    'groups.menu.notFoundBody': 'Vielleicht wurde es gerade gelöscht.',
    'groups.menu.created': 'Sprachmenü {name} angelegt',
    'groups.menu.saved': 'Sprachmenü gespeichert',
    'groups.menu.deleted': 'Sprachmenü {name} gelöscht',
    'groups.menu.keysSaved': 'Tastenbelegung gespeichert',
    'groups.menu.tab.keys': 'Tasten',
    'groups.menu.tab.settings': 'Einstellungen',
    'groups.menu.tab.schedule': 'Zeiten & Abwesenheit',
    'groups.menu.cardGreeting': 'Ansage',
    'groups.menu.cardBehaviour': 'Ablauf',
    'groups.menu.extensionDialingLabel':
      'Anrufende dürfen Durchwahlen direkt wählen',
    'groups.menu.fallbackDesc':
      'Wohin der Anruf geht, wenn nach {attempts} Versuchen keine passende Taste gedrückt wurde.',
    'groups.menu.flowLabel': 'Ablauf des Sprachmenüs',
    'groups.menu.flowGreeting': '1 · Ansage',
    'groups.menu.flowWait': '2 · Taste wählen',
    'groups.menu.flowWaitValue': '{seconds} s Zeit',
    'groups.menu.flowFallback': '3 · Nach {attempts} Versuchen',
    'groups.menu.keysTitle': 'Tastenbelegung',
    'groups.menu.keysDesc':
      'Tippen Sie auf eine Taste, um festzulegen, wohin sie verbindet.',
    'groups.menu.keypadLabel': 'Telefontastatur',
    'groups.menu.keyFree': 'Taste {digits}, nicht belegt',
    'groups.menu.keyMapped': 'Taste {digits}: {target}',
    'groups.menu.keyMailbox': 'Mailbox',
    'groups.menu.sequences': 'Längere Tastenfolgen',
    'groups.menu.whenPressed': 'Wer {digits} drückt …',
    'groups.menu.mappedHint': '… wird hierhin verbunden.',
    'groups.menu.unmapped': '… hört die Ansage noch einmal.',
    'groups.menu.unmappedBody':
      'Diese Taste ist nicht belegt. Nach den Versuchen gilt das Ausweichziel.',
    'groups.menu.unmappedExt':
      'Nicht belegt. Ist die Eingabe eine Durchwahl, wird direkt dorthin verbunden.',
    'groups.menu.assign': 'Taste belegen',
    'groups.menu.unassign': 'Belegung entfernen',
    'groups.menu.overview': 'Alle Belegungen',

    'groups.audio.subtitle':
      'Begrüßungen, Wartemusik, Mailbox-Ansagen und Ansagen für Sprachmenüs.',
    'groups.audio.upload': 'Audiodatei hochladen',
    'groups.audio.uploadSub':
      'WAV oder MP3, höchstens 50 MB. Die Telefonanlage wandelt die Datei passend um.',
    'groups.audio.uploadAction': 'Hochladen',
    'groups.audio.kind.greeting': 'Begrüßungen',
    'groups.audio.kind.greeting.one': 'Begrüßung',
    'groups.audio.kind.greeting.desc':
      'Hören Anrufende, bevor eine Rufgruppe klingelt.',
    'groups.audio.kind.moh': 'Wartemusik',
    'groups.audio.kind.moh.one': 'Wartemusik',
    'groups.audio.kind.moh.desc':
      'Läuft beim Halten und statt Freizeichen, während eine Rufgruppe klingelt.',
    'groups.audio.kind.vmGreeting': 'Mailbox-Ansagen',
    'groups.audio.kind.vmGreeting.one': 'Mailbox-Ansage',
    'groups.audio.kind.vmGreeting.desc':
      'Begrüßen Anrufende auf einer Mailbox.',
    'groups.audio.kind.announcement': 'Ansagen',
    'groups.audio.kind.announcement.one': 'Ansage',
    'groups.audio.kind.announcement.desc':
      'Für Sprachmenüs und als Ziel, z. B. „Wir haben geschlossen“.',
    'groups.audio.none': 'Noch keine Dateien.',
    'groups.audio.noFile': 'Für diese Datei ist keine Hörprobe verfügbar',
    'groups.audio.bundled': 'Mitgeliefert',
    'groups.audio.bundledHelp':
      'Mitgelieferte Musik (opsound, CC BY-SA 3.0): frei von GEMA- und AKM-Gebühren.',
    'groups.audio.since': 'mitgeliefert seit {date}',
    'groups.audio.uploaded': 'hochgeladen am {date}',
    'groups.audio.unused': 'Wird nirgends verwendet',
    'groups.audio.usedBy': 'Verwendet von',
    'groups.audio.rename': 'Umbenennen',
    'groups.audio.renamed': 'Umbenannt',
    'groups.audio.created': '{name} hochgeladen',
    'groups.audio.deleted': '{name} gelöscht',
    'groups.audio.mohNote':
      'Die mitgelieferte Musik ist frei von GEMA- und AKM-Gebühren. Für hochgeladene Musik sind Sie selbst für die Lizenz verantwortlich.',
    'groups.audio.licenseNote':
      'Für hochgeladene Wartemusik sind Sie selbst für die Lizenz verantwortlich (z. B. GEMA).',
    'groups.audio.dropTitle': 'Datei auswählen oder hierher ziehen',
    'groups.audio.dropHint': 'WAV oder MP3, höchstens 50 MB',
    'groups.audio.pickFile': 'Bitte wählen Sie eine Datei aus.',
    'groups.audio.tooLarge':
      'Die Datei ist {size} groß; erlaubt sind höchstens 50 MB.',
    'groups.audio.labelPlaceholder': 'z. B. Außerhalb der Bürozeiten',
    'groups.audio.transcoding': 'Wird für die Telefonanlage umgewandelt …',

    'groups.sched.hoursTitle': 'Öffnungszeiten',
    'groups.sched.hoursDesc':
      'Außerhalb dieser Zeiten gehen Anrufe an das Ziel für „geschlossen“.',
    'groups.sched.hoursDescOwn':
      'Außerhalb Ihrer Zeiten gehen Ihre Anrufe an das Ziel, das Sie hier festlegen.',
    'groups.sched.hoursDescTenant':
      'Gelten für alle, die keine eigenen Öffnungszeiten haben.',
    'groups.sched.openNow': 'Jetzt geöffnet',
    'groups.sched.openUntil': 'Geöffnet bis {when}',
    'groups.sched.closedNow': 'Jetzt geschlossen',
    'groups.sched.closedUntil': 'Geschlossen bis {when}',
    'groups.sched.alwaysOpen': 'Immer erreichbar',
    'groups.sched.fromCompany': 'Nach den Firmen-Öffnungszeiten',
    'groups.sched.followsCompany': 'Es gelten die Firmen-Öffnungszeiten',
    'groups.sched.followsCompanyBody':
      'Solange keine eigenen Zeiten festgelegt sind.',
    'groups.sched.companyInactive':
      'Die Firmen-Öffnungszeiten sind ausgeschaltet: Anrufe kommen jederzeit durch.',
    'groups.sched.noneTenant': 'Keine Öffnungszeiten festgelegt',
    'groups.sched.noneTenantBody': 'Anrufe kommen rund um die Uhr durch.',
    'groups.sched.setOwn': 'Eigene Zeiten festlegen',
    'groups.sched.setTenant': 'Öffnungszeiten festlegen',
    'groups.sched.activeOwn': 'Eigene Öffnungszeiten verwenden',
    'groups.sched.activeOwnHelp':
      'Wenn ausgeschaltet, bleiben die Zeiten gespeichert und es gelten die Firmen-Öffnungszeiten.',
    'groups.sched.activeTenant': 'Öffnungszeiten anwenden',
    'groups.sched.activeTenantHelp':
      'Wenn ausgeschaltet, bleiben die Zeiten gespeichert und Anrufe kommen jederzeit durch.',
    'groups.sched.pickTarget': 'Ziel wählen …',
    'groups.sched.pickTargetError': 'Bitte wählen Sie ein Ziel.',
    'groups.sched.removeOwn': 'Wieder Firmen-Zeiten verwenden',
    'groups.sched.removeTenant': 'Öffnungszeiten entfernen',
    'groups.sched.hoursSaved': 'Öffnungszeiten gespeichert',
    'groups.sched.hoursRemoved': 'Es gelten wieder die Firmen-Öffnungszeiten',
    'groups.sched.hoursRemovedTenant': 'Öffnungszeiten entfernt',
    'groups.sched.oooTitle': 'Abwesenheiten',
    'groups.sched.oooDesc':
      'Während einer Abwesenheit gehen Anrufe an ihr Ziel – vor den Öffnungszeiten.',
    'groups.sched.oooDescOwn':
      'Urlaub, Termine, Homeoffice: Solange eine Abwesenheit läuft, gehen Ihre Anrufe an deren Ziel.',
    'groups.sched.oooDescTenant':
      'Betriebsferien und Feiertage: gelten für alle, die gerade keine eigene Abwesenheit haben.',
    'groups.sched.oooAdd': 'Abwesenheit eintragen',
    'groups.sched.oooEdit': 'Abwesenheit bearbeiten',
    'groups.sched.oooDrawerSub':
      'Eingeschaltete Abwesenheiten dürfen sich hier nicht überschneiden.',
    'groups.sched.oooNowUntil': 'Gerade abwesend – bis {until}',
    'groups.sched.oooNowOpen': 'Gerade abwesend – bis auf Weiteres',
    'groups.sched.oooInherited': 'Abwesenheit der ganzen Firma',
    'groups.sched.callsGoTo': 'Anrufe gehen an',
    'groups.sched.immediately': 'ab sofort',
    'groups.sched.untilOff': 'bis auf Weiteres',
    'groups.sched.startNow': 'Ab sofort',
    'groups.sched.startAt': 'Ab Zeitpunkt',
    'groups.sched.endAt': 'Bis Zeitpunkt',
    'groups.sched.endOpen': 'Bis auf Weiteres',
    'groups.sched.oooActiveLabel': 'Abwesenheit ist eingeschaltet',
    'groups.sched.oooCreated': 'Abwesenheit eingetragen',
    'groups.sched.oooSaved': 'Abwesenheit gespeichert',
    'groups.sched.oooDeleted': 'Abwesenheit gelöscht',
    'groups.sched.oooOn': 'Abwesenheit eingeschaltet',
    'groups.sched.oooOff': 'Abwesenheit ausgeschaltet',
    'groups.sched.state.now': 'Läuft gerade',
    'groups.sched.state.planned': 'Geplant',
    'groups.sched.state.ended': 'Vorbei',
    'groups.sched.state.off': 'Ausgeschaltet',

    'groups.hours.subtitle':
      'Wann Ihre Firma erreichbar ist – und wohin Anrufe sonst gehen.',
    'groups.hours.precedenceTitle': 'So wird entschieden',
    'groups.hours.precedenceLead':
      'Bei jedem Anruf an eine Person, Rufgruppe oder ein Sprachmenü gilt diese Reihenfolge:',
    'groups.hours.step.ooo': 'Abwesenheit',
    'groups.hours.step.ooo.body':
      'Läuft eine Abwesenheit – die eigene, sonst die der Firma –, geht der Anruf an ihr Ziel.',
    'groups.hours.step.hours': 'Öffnungszeiten',
    'groups.hours.step.hours.body':
      'Außerhalb der Öffnungszeiten – der eigenen, sonst der Firma – geht er an das Ziel für „geschlossen“.',
    'groups.hours.step.ring': 'Normal klingeln',
    'groups.hours.step.ring.body': 'Sonst klingelt es ganz normal.',
    'groups.hours.internalNote':
      'Interne Anrufe zwischen Kolleg:innen sind von Öffnungszeiten nicht betroffen.',
    'groups.hours.companyTitle': 'Öffnungszeiten der Firma',
    'groups.hours.overviewTitle': 'Eigene Regeln',
    'groups.hours.overviewDesc':
      'Personen, Rufgruppen und Sprachmenüs mit eigenen Öffnungszeiten oder Abwesenheiten.',
    'groups.hours.overviewEmpty': 'Überall gelten die Firmen-Regeln',
    'groups.hours.overviewEmptyBody':
      'Niemand hat eigene Öffnungszeiten oder Abwesenheiten.',
    'groups.hours.who': 'Wer',
    'groups.hours.ownHours': 'Eigene Öffnungszeiten',
    'groups.hours.ownOoo': 'Abwesenheit',
    'groups.hours.followsCompany': 'wie die Firma',
    'groups.hours.ownInactive': 'ausgeschaltet',
    'groups.hours.oooNow': 'Gerade abwesend',
    'groups.hours.oooNowUntil': 'Abwesend bis {until}',
    'groups.hours.oooPlanned': '{from} – {to}',
    'groups.hours.oooInactiveOnly': 'nur ausgeschaltete',
    'groups.hours.kind.user': 'Person',
    'groups.hours.kind.ringGroup': 'Rufgruppe',
    'groups.hours.kind.menu': 'Sprachmenü',

    'field.ringGroup.name': 'Name',
    'field.ringGroup.ext': 'Durchwahl',
    'field.ringGroup.strategy': 'Klingelreihenfolge',
    'field.ringGroup.members': 'Mitglieder',
    'field.ringGroup.ringTimeoutS': 'Klingeldauer',
    'field.ringGroup.ringTimeoutS.help':
      'Bei „Alle gleichzeitig“ insgesamt, sonst je Person.',
    'field.ringGroup.ringTotalS': 'Maximale Gesamtdauer',
    'field.ringGroup.ringTotalS.help':
      'Danach gilt die Weiterleitung, auch wenn noch nicht alle geklingelt haben.',
    'field.ringGroup.skipBusy': 'Besetzt',
    'field.ringGroup.skipBusy.help':
      'Wenn ausgeschaltet, erhalten Personen im Gespräch den Anruf als Anklopfen auf ihren anderen Geräten.',
    'field.ringGroup.allowReject': 'Ablehnen',
    'field.ringGroup.allowReject.help':
      'Lehnen alle ab, gilt die Weiterleitung sofort.',
    'field.ringGroup.greetingAudioId': 'Begrüßung',
    'field.ringGroup.mohAudioId': 'Musik während des Klingelns',
    'field.ringGroup.recordCalls': 'Aufzeichnung',
    'field.ringGroup.recordCalls.help':
      'Unabhängig von den Einstellungen der Person, die abnimmt. Holen Sie die nötige Einwilligung ein.',
    'field.ringGroup.mailboxEnabled': 'Mailbox',
    'field.ringGroup.mailboxAudioId': 'Mailbox-Ansage',
    'field.ringGroup.mailboxMaxMessages': 'Maximale Anzahl Nachrichten',
    'field.ringGroup.mailboxMaxMessages.help':
      'Ist die Mailbox voll, erfahren Anrufende das und können keine Nachricht hinterlassen. Leer: unbegrenzt.',
    'field.ringGroup.logLevel': 'Diagnosestufe',
    'field.ringGroup.logLevelExpiresAt': 'Diagnose bis',
    'field.ringGroup.rules': 'Weiterleitung',

    'field.menu.name': 'Name',
    'field.menu.audioId': 'Ansage',
    'field.menu.audioId.help': 'Eine Audiodatei der Art „Ansage“.',
    'field.menu.timeoutS': 'Wartezeit auf eine Taste',
    'field.menu.timeoutS.help': 'Nach der Ansage, bis zur ersten Taste.',
    'field.menu.maxAttempts': 'Versuche',
    'field.menu.maxAttempts.help':
      'So oft wird die Ansage wiederholt, wenn nichts oder eine unbelegte Taste gedrückt wird.',
    'field.menu.allowExtensionDialing': 'Durchwahl wählen',
    'field.menu.fallbackTarget': 'Ausweichziel',
    'field.menu.targets': 'Tastenbelegung',

    'field.audio.upload': 'Datei',
    'field.audio.kind': 'Wofür?',
    'field.audio.label': 'Bezeichnung',

    'field.oooRule.startsAt': 'Beginn',
    'field.oooRule.expiresAt': 'Ende',
    'field.oooRule.target': 'Anrufe gehen in dieser Zeit an',
    'field.oooRule.active': 'Eingeschaltet',

    'field.openingHours.active': 'Gültigkeit',
    'field.openingHours.intervals': 'Geöffnet',
    'field.openingHours.closedTarget': 'Wenn geschlossen, gehen Anrufe an',
    'field.openingHours.closedTarget.help':
      'Gilt für Anrufe von außen und Weiterleitungen, nicht für interne Anrufe.',

    'confirm.ringGroups.delete.title': 'Rufgruppe {name} löschen?',
    'confirm.ringGroups.delete.body':
      'Die Durchwahl {ext} wird frei. Sie können das Löschen {days} Tage lang rückgängig machen.',
    'confirm.ringGroups.delete.action': 'Löschen',
    'confirm.ringGroups.deleteAnytime.title': 'Rufgruppe {name} löschen?',
    'confirm.ringGroups.deleteAnytime.body':
      'Die Durchwahl {ext} wird frei. Sie können das Löschen jederzeit rückgängig machen.',
    'confirm.ringGroups.deleteAnytime.action': 'Löschen',
    'confirm.menus.delete.title': 'Sprachmenü {name} löschen?',
    'confirm.menus.delete.body':
      'Sie können das Löschen {days} Tage lang rückgängig machen.',
    'confirm.menus.delete.action': 'Löschen',
    'confirm.menus.deleteAnytime.title': 'Sprachmenü {name} löschen?',
    'confirm.menus.deleteAnytime.body':
      'Sie können das Löschen jederzeit rückgängig machen.',
    'confirm.menus.deleteAnytime.action': 'Löschen',
    'confirm.audio.delete.title': '{name} löschen?',
    'confirm.audio.delete.body':
      'Sie können das Löschen {days} Tage lang rückgängig machen.',
    'confirm.audio.delete.action': 'Löschen',
    'confirm.audio.deleteAnytime.title': '{name} löschen?',
    'confirm.audio.deleteAnytime.body':
      'Sie können das Löschen jederzeit rückgängig machen.',
    'confirm.audio.deleteAnytime.action': 'Löschen',
    'confirm.ooo.delete.title': 'Abwesenheit löschen?',
    'confirm.ooo.delete.body':
      'Die Abwesenheit von {name} wird gelöscht. Sie können das {days} Tage lang rückgängig machen.',
    'confirm.ooo.delete.action': 'Löschen',
    'confirm.ooo.deleteAnytime.title': 'Abwesenheit löschen?',
    'confirm.ooo.deleteAnytime.body':
      'Die Abwesenheit von {name} wird gelöscht. Sie können das jederzeit rückgängig machen.',
    'confirm.ooo.deleteAnytime.action': 'Löschen',
    'confirm.hours.delete.title': 'Eigene Öffnungszeiten entfernen?',
    'confirm.hours.delete.body':
      'Für {name} gelten dann wieder die Firmen-Öffnungszeiten. Sie können das {days} Tage lang rückgängig machen.',
    'confirm.hours.delete.action': 'Entfernen',
    'confirm.hours.deleteAnytime.title': 'Eigene Öffnungszeiten entfernen?',
    'confirm.hours.deleteAnytime.body':
      'Für {name} gelten dann wieder die Firmen-Öffnungszeiten. Sie können das jederzeit rückgängig machen.',
    'confirm.hours.deleteAnytime.action': 'Entfernen',
    'confirm.hours.deleteTenant.title': 'Öffnungszeiten der Firma entfernen?',
    'confirm.hours.deleteTenant.body':
      'Anrufe kommen dann rund um die Uhr durch, außer wo eigene Zeiten gelten. Sie können das {days} Tage lang rückgängig machen.',
    'confirm.hours.deleteTenant.action': 'Entfernen',
    'confirm.hours.deleteTenantAnytime.title':
      'Öffnungszeiten der Firma entfernen?',
    'confirm.hours.deleteTenantAnytime.body':
      'Anrufe kommen dann rund um die Uhr durch, außer wo eigene Zeiten gelten. Sie können das jederzeit rückgängig machen.',
    'confirm.hours.deleteTenantAnytime.action': 'Entfernen',

    'errors.groups.required': 'Bitte ausfüllen.',
    'errors.groups.range': 'Bitte eine ganze Zahl von {min} bis {max} angeben.',
    'errors.groups.positive': 'Bitte eine ganze Zahl ab 1 angeben.',
    'errors.groups.e164':
      '„{value}“ ist keine gültige Rufnummer im internationalen Format (z. B. +4989123456).',
    'errors.groups.sipUser':
      'Der SIP-Benutzer darf nur Buchstaben, Ziffern und . _ ~ + - enthalten (höchstens 64 Zeichen).',
    'errors.groups.adminTarget': 'Dieses Ziel kann nur ein Admin festlegen.',
    'errors.groups.audioKind':
      'Diese Audiodatei passt hier nicht; benötigt wird eine der Art „{kind}“.',
    'errors.groups.audioKindUnknown': 'Bitte wählen Sie, wofür die Datei ist.',
    'errors.groups.uploadType': 'Nur WAV- und MP3-Dateien werden unterstützt.',
    'errors.groups.strategy': 'Bitte wählen Sie eine Klingelreihenfolge.',
    'errors.groups.duplicateMember': 'Ein Mitglied ist doppelt eingetragen.',
    'errors.groups.noExtension':
      'Diese Person hat keine Durchwahl und kann nicht klingeln. Geben Sie ihr zuerst eine:',
    'errors.groups.noFreeExtension': 'Es ist keine Durchwahl mehr frei.',
    'errors.groups.logLevel': 'Unbekannte Diagnosestufe.',
    'errors.groups.logLevelExpiry':
      'Ein Ablaufdatum braucht eine Diagnosestufe.',
    'errors.groups.condition': 'Unbekannte Bedingung.',
    'errors.groups.duplicateCondition':
      'Für jede Bedingung ist nur eine Regel möglich.',
    'errors.groups.digits':
      '„{digits}“ ist ungültig: Erlaubt sind nur Ziffern, * und #.',
    'errors.groups.duplicateDigits':
      'Die Tastenfolge {digits} ist schon belegt.',
    'errors.groups.datetime': 'Bitte ein gültiges Datum mit Uhrzeit angeben.',
    'errors.groups.oooOrder': 'Das Ende muss nach dem Beginn liegen.',
    'errors.groups.oooOverlap':
      'Dieser Zeitraum überschneidet sich mit einer anderen eingeschalteten Abwesenheit.',
    'errors.groups.weekday': 'Unbekannter Wochentag {weekday}.',
    'errors.groups.hoursTime': 'Ungültige Uhrzeit in {range}.',
    'errors.groups.hoursMidnight':
      '{range} geht über Mitternacht; teilen Sie den Zeitraum in zwei.',
    'errors.groups.hoursDuplicate':
      'Zwei Zeiträume beginnen am selben Tag um {opens}.',
    'errors.groups.noSchedule':
      'Hier sind keine eigenen Öffnungszeiten festgelegt.'
  },
  en: {
    'groups.unsaved': 'Unsaved changes',

    'groups.rg.subtitle':
      'Several people behind one extension, rung all at once, in turn or at random.',
    'groups.rg.add': 'New ring group',
    'groups.rg.addSub': 'The extension is assigned automatically.',
    'groups.rg.namePlaceholder': 'e.g. Reception',
    'groups.rg.extAuto': 'The next free extension, assigned automatically.',
    'groups.rg.extShort': 'Extension {ext}',
    'groups.rg.features': 'Features',
    'groups.rg.now': 'Right now',
    'groups.rg.mailbox': 'Voicemail',
    'groups.rg.recording': 'Recording',
    'groups.rg.music': 'Music',
    'groups.rg.noMembers': 'No members',
    'groups.rg.statusOpen': 'Reachable',
    'groups.rg.statusClosed': 'Closed',
    'groups.rg.statusOoo': 'Out of office',
    'groups.rg.empty': 'No ring groups yet',
    'groups.rg.emptyBody':
      'Group colleagues so calls ring all of them at once or one after the other.',
    'groups.rg.notFound': 'This ring group does not exist (any more)',
    'groups.rg.notFoundBody': 'Perhaps it was just deleted.',
    'groups.rg.created': 'Ring group {name} created',
    'groups.rg.saved': 'Ring group saved',
    'groups.rg.deleted': 'Ring group {name} deleted',
    'groups.rg.forwardingSaved': 'Forwarding saved',
    'groups.rg.tab.settings': 'Settings',
    'groups.rg.tab.forwarding': 'Forwarding',
    'groups.rg.tab.schedule': 'Hours & absences',
    'groups.rg.strategy.simultaneous': 'All at once',
    'groups.rg.strategy.simultaneous.desc':
      'Every phone rings together; whoever picks up first takes the call.',
    'groups.rg.strategy.sequential': 'In turn',
    'groups.rg.strategy.sequential.desc':
      'One person after the other, in the order of the members.',
    'groups.rg.strategy.random': 'At random',
    'groups.rg.strategy.random.desc':
      'One person after the other, shuffled every time.',
    'groups.rg.cardGeneral': 'General',
    'groups.rg.cardRinging': 'Ringing',
    'groups.rg.cardAudio': 'Greeting & music',
    'groups.rg.cardAudioDesc': 'What callers hear before someone picks up.',
    'groups.rg.cardMailbox': 'Voicemail & recording',
    'groups.rg.cardDiagnostics': 'Diagnostics',
    'groups.rg.membersDesc': 'People and user groups whose phones ring.',
    'groups.rg.membersOrdered': 'Order matters: the top one rings first.',
    'groups.rg.reachedVia': 'Reached via',
    'groups.rg.capOn': 'Limit the total time',
    'groups.rg.capSimultaneous': 'Applies to "In turn" and "At random" only.',
    'groups.rg.skipBusyLabel': 'Skip people who are on a call',
    'groups.rg.allowRejectLabel': 'Members may decline calls',
    'groups.rg.noGreeting': 'No greeting',
    'groups.rg.ringback': 'Normal ringback tone',
    'groups.rg.standardGreeting': 'Standard greeting',
    'groups.rg.toAudio': 'Manage audio files →',
    'groups.rg.mailboxLabel': 'Own voicemail box for the group',
    'groups.rg.recordLabel': "Record all of the group's calls",
    'groups.rg.forwardingTitle': 'When nobody picks up',
    'groups.rg.forwardingDesc':
      'Where calls go that nobody in the group takes.',
    'groups.rg.condition.unanswered': 'Nobody answers',
    'groups.rg.condition.unanswered.desc':
      'It rang, but nobody picked up in time.',
    'groups.rg.condition.unavailable': 'Nobody is reachable',
    'groups.rg.condition.unavailable.desc':
      'No member can ring right now, e.g. everyone signed out or on do not disturb.',
    'groups.rg.ruleOn': 'Forward',
    'groups.rg.noUnansweredMailbox':
      "Without a rule, calls go to the group's voicemail.",
    'groups.rg.noUnansweredReject':
      'Without a rule or a voicemail box, the call is rejected.',
    'groups.rg.noUnavailable':
      'Without a rule, the same applies as for "Nobody answers".',

    'groups.menu.subtitle':
      'An announcement with key choices: "For accounts, press 2 …"',
    'groups.menu.add': 'New phone menu',
    'groups.menu.addSub':
      'Announcement and fallback; you assign the keys afterwards.',
    'groups.menu.addHint': 'Once created, assign a destination to each key.',
    'groups.menu.namePlaceholder': 'e.g. Main menu',
    'groups.menu.noAnnouncements': 'There is no announcement yet.',
    'groups.menu.keys': 'Keys',
    'groups.menu.noKeys': 'No key assigned yet',
    'groups.menu.keyCount': '{count} keys assigned',
    'groups.menu.empty': 'No phone menus yet',
    'groups.menu.emptyBody':
      'Greet callers with an announcement and let them choose with a key.',
    'groups.menu.notFound': 'This phone menu does not exist (any more)',
    'groups.menu.notFoundBody': 'Perhaps it was just deleted.',
    'groups.menu.created': 'Phone menu {name} created',
    'groups.menu.saved': 'Phone menu saved',
    'groups.menu.deleted': 'Phone menu {name} deleted',
    'groups.menu.keysSaved': 'Key assignments saved',
    'groups.menu.tab.keys': 'Keys',
    'groups.menu.tab.settings': 'Settings',
    'groups.menu.tab.schedule': 'Hours & absences',
    'groups.menu.cardGreeting': 'Announcement',
    'groups.menu.cardBehaviour': 'Flow',
    'groups.menu.extensionDialingLabel': 'Callers may dial extensions directly',
    'groups.menu.fallbackDesc':
      'Where the call goes when no matching key was pressed after {attempts} attempts.',
    'groups.menu.flowLabel': 'How the phone menu runs',
    'groups.menu.flowGreeting': '1 · Announcement',
    'groups.menu.flowWait': '2 · Key choice',
    'groups.menu.flowWaitValue': '{seconds} s to choose',
    'groups.menu.flowFallback': '3 · After {attempts} attempts',
    'groups.menu.keysTitle': 'Key assignments',
    'groups.menu.keysDesc': 'Tap a key to choose where it connects.',
    'groups.menu.keypadLabel': 'Phone keypad',
    'groups.menu.keyFree': 'Key {digits}, not assigned',
    'groups.menu.keyMapped': 'Key {digits}: {target}',
    'groups.menu.keyMailbox': 'Voicemail',
    'groups.menu.sequences': 'Longer key sequences',
    'groups.menu.whenPressed': 'Whoever presses {digits} …',
    'groups.menu.mappedHint': '… is connected here.',
    'groups.menu.unmapped': '… hears the announcement again.',
    'groups.menu.unmappedBody':
      'This key is not assigned. After the attempts, the fallback applies.',
    'groups.menu.unmappedExt':
      'Not assigned. If the input is an extension, the call goes straight there.',
    'groups.menu.assign': 'Assign key',
    'groups.menu.unassign': 'Remove assignment',
    'groups.menu.overview': 'All assignments',

    'groups.audio.subtitle':
      'Greetings, hold music, voicemail greetings and announcements for phone menus.',
    'groups.audio.upload': 'Upload audio file',
    'groups.audio.uploadSub':
      'WAV or MP3, at most 50 MB. The phone system converts the file to suit.',
    'groups.audio.uploadAction': 'Upload',
    'groups.audio.kind.greeting': 'Greetings',
    'groups.audio.kind.greeting.one': 'Greeting',
    'groups.audio.kind.greeting.desc':
      'Callers hear these before a ring group rings.',
    'groups.audio.kind.moh': 'Hold music',
    'groups.audio.kind.moh.one': 'Hold music',
    'groups.audio.kind.moh.desc':
      'Plays on hold, and instead of ringback while a ring group rings.',
    'groups.audio.kind.vmGreeting': 'Voicemail greetings',
    'groups.audio.kind.vmGreeting.one': 'Voicemail greeting',
    'groups.audio.kind.vmGreeting.desc': 'Greet callers on a voicemail box.',
    'groups.audio.kind.announcement': 'Announcements',
    'groups.audio.kind.announcement.one': 'Announcement',
    'groups.audio.kind.announcement.desc':
      'For phone menus and as a destination, e.g. "We are closed".',
    'groups.audio.none': 'No files yet.',
    'groups.audio.noFile': 'No preview available for this file',
    'groups.audio.bundled': 'Bundled',
    'groups.audio.bundledHelp':
      'Bundled music (opsound, CC BY-SA 3.0): free of GEMA and AKM fees.',
    'groups.audio.since': 'bundled since {date}',
    'groups.audio.uploaded': 'uploaded {date}',
    'groups.audio.unused': 'Not used anywhere',
    'groups.audio.usedBy': 'Used by',
    'groups.audio.rename': 'Rename',
    'groups.audio.renamed': 'Renamed',
    'groups.audio.created': '{name} uploaded',
    'groups.audio.deleted': '{name} deleted',
    'groups.audio.mohNote':
      'The bundled music is free of GEMA and AKM fees. Licensing music you upload is your own responsibility.',
    'groups.audio.licenseNote':
      'Licensing hold music you upload (e.g. with GEMA) is your own responsibility.',
    'groups.audio.dropTitle': 'Choose a file or drop it here',
    'groups.audio.dropHint': 'WAV or MP3, at most 50 MB',
    'groups.audio.pickFile': 'Please choose a file.',
    'groups.audio.tooLarge': 'The file is {size}; the limit is 50 MB.',
    'groups.audio.labelPlaceholder': 'e.g. Outside office hours',
    'groups.audio.transcoding': 'Converting for the phone system …',

    'groups.sched.hoursTitle': 'Opening hours',
    'groups.sched.hoursDesc':
      'Outside these hours, calls go to the "closed" destination.',
    'groups.sched.hoursDescOwn':
      'Outside your hours, your calls go to the destination you choose here.',
    'groups.sched.hoursDescTenant':
      'Apply to everyone without opening hours of their own.',
    'groups.sched.openNow': 'Open now',
    'groups.sched.openUntil': 'Open until {when}',
    'groups.sched.closedNow': 'Closed now',
    'groups.sched.closedUntil': 'Closed until {when}',
    'groups.sched.alwaysOpen': 'Always reachable',
    'groups.sched.fromCompany': "By the company's opening hours",
    'groups.sched.followsCompany': "The company's opening hours apply",
    'groups.sched.followsCompanyBody':
      'As long as no hours of its own are set.',
    'groups.sched.companyInactive':
      "The company's opening hours are switched off: calls come through at any time.",
    'groups.sched.noneTenant': 'No opening hours set',
    'groups.sched.noneTenantBody': 'Calls come through around the clock.',
    'groups.sched.setOwn': 'Set own hours',
    'groups.sched.setTenant': 'Set opening hours',
    'groups.sched.activeOwn': 'Use own opening hours',
    'groups.sched.activeOwnHelp':
      "When off, the hours stay saved and the company's opening hours apply.",
    'groups.sched.activeTenant': 'Apply opening hours',
    'groups.sched.activeTenantHelp':
      'When off, the hours stay saved and calls come through at any time.',
    'groups.sched.pickTarget': 'Choose a destination …',
    'groups.sched.pickTargetError': 'Please choose a destination.',
    'groups.sched.removeOwn': "Use the company's hours again",
    'groups.sched.removeTenant': 'Remove opening hours',
    'groups.sched.hoursSaved': 'Opening hours saved',
    'groups.sched.hoursRemoved': "The company's opening hours apply again",
    'groups.sched.hoursRemovedTenant': 'Opening hours removed',
    'groups.sched.oooTitle': 'Absences',
    'groups.sched.oooDesc':
      'During an absence, calls go to its destination, ahead of opening hours.',
    'groups.sched.oooDescOwn':
      'Holiday, appointments, working from home: while an absence runs, your calls go to its destination.',
    'groups.sched.oooDescTenant':
      'Company holidays and public holidays: apply to everyone without an absence of their own.',
    'groups.sched.oooAdd': 'Add absence',
    'groups.sched.oooEdit': 'Edit absence',
    'groups.sched.oooDrawerSub':
      'Absences that are switched on must not overlap here.',
    'groups.sched.oooNowUntil': 'Out of office until {until}',
    'groups.sched.oooNowOpen': 'Out of office until further notice',
    'groups.sched.oooInherited': "The whole company's absence",
    'groups.sched.callsGoTo': 'Calls go to',
    'groups.sched.immediately': 'from now',
    'groups.sched.untilOff': 'until further notice',
    'groups.sched.startNow': 'From now',
    'groups.sched.startAt': 'From a date',
    'groups.sched.endAt': 'Until a date',
    'groups.sched.endOpen': 'Until further notice',
    'groups.sched.oooActiveLabel': 'Absence is switched on',
    'groups.sched.oooCreated': 'Absence added',
    'groups.sched.oooSaved': 'Absence saved',
    'groups.sched.oooDeleted': 'Absence deleted',
    'groups.sched.oooOn': 'Absence switched on',
    'groups.sched.oooOff': 'Absence switched off',
    'groups.sched.state.now': 'Running now',
    'groups.sched.state.planned': 'Planned',
    'groups.sched.state.ended': 'Over',
    'groups.sched.state.off': 'Switched off',

    'groups.hours.subtitle':
      'When your company is reachable, and where calls go otherwise.',
    'groups.hours.precedenceTitle': 'How it is decided',
    'groups.hours.precedenceLead':
      'Every call to a person, ring group or phone menu follows this order:',
    'groups.hours.step.ooo': 'Absence',
    'groups.hours.step.ooo.body':
      "If an absence runs (their own, else the company's), the call goes to its destination.",
    'groups.hours.step.hours': 'Opening hours',
    'groups.hours.step.hours.body':
      'Outside the opening hours (their own, else the company\'s), it goes to the "closed" destination.',
    'groups.hours.step.ring': 'Ring as usual',
    'groups.hours.step.ring.body': 'Otherwise it rings as usual.',
    'groups.hours.internalNote':
      'Internal calls between colleagues are not affected by opening hours.',
    'groups.hours.companyTitle': "The company's opening hours",
    'groups.hours.overviewTitle': 'Own rules',
    'groups.hours.overviewDesc':
      'People, ring groups and phone menus with opening hours or absences of their own.',
    'groups.hours.overviewEmpty': "The company's rules apply everywhere",
    'groups.hours.overviewEmptyBody':
      'Nobody has opening hours or absences of their own.',
    'groups.hours.who': 'Who',
    'groups.hours.ownHours': 'Own opening hours',
    'groups.hours.ownOoo': 'Absence',
    'groups.hours.followsCompany': 'same as company',
    'groups.hours.ownInactive': 'switched off',
    'groups.hours.oooNow': 'Out of office',
    'groups.hours.oooNowUntil': 'Out until {until}',
    'groups.hours.oooPlanned': '{from} – {to}',
    'groups.hours.oooInactiveOnly': 'switched off only',
    'groups.hours.kind.user': 'Person',
    'groups.hours.kind.ringGroup': 'Ring group',
    'groups.hours.kind.menu': 'Phone menu',

    'field.ringGroup.name': 'Name',
    'field.ringGroup.ext': 'Extension',
    'field.ringGroup.strategy': 'Ring order',
    'field.ringGroup.members': 'Members',
    'field.ringGroup.ringTimeoutS': 'Ringing time',
    'field.ringGroup.ringTimeoutS.help':
      'In total for "All at once", otherwise per person.',
    'field.ringGroup.ringTotalS': 'Maximum total time',
    'field.ringGroup.ringTotalS.help':
      'After that, forwarding applies, even if not everyone has rung yet.',
    'field.ringGroup.skipBusy': 'Busy',
    'field.ringGroup.skipBusy.help':
      'When off, people on a call receive it as call waiting on their other devices.',
    'field.ringGroup.allowReject': 'Declining',
    'field.ringGroup.allowReject.help':
      'When everyone declines, forwarding applies at once.',
    'field.ringGroup.greetingAudioId': 'Greeting',
    'field.ringGroup.mohAudioId': 'Music while ringing',
    'field.ringGroup.recordCalls': 'Recording',
    'field.ringGroup.recordCalls.help':
      "Regardless of the answering person's own setting. Make sure you have the required consent.",
    'field.ringGroup.mailboxEnabled': 'Voicemail',
    'field.ringGroup.mailboxAudioId': 'Voicemail greeting',
    'field.ringGroup.mailboxMaxMessages': 'Maximum messages',
    'field.ringGroup.mailboxMaxMessages.help':
      'When the voicemail is full, callers are told so and cannot leave a message. Empty: no limit.',
    'field.ringGroup.logLevel': 'Diagnostics level',
    'field.ringGroup.logLevelExpiresAt': 'Diagnostics until',
    'field.ringGroup.rules': 'Forwarding',

    'field.menu.name': 'Name',
    'field.menu.audioId': 'Announcement',
    'field.menu.audioId.help': 'An audio file of the kind "Announcement".',
    'field.menu.timeoutS': 'Time to press a key',
    'field.menu.timeoutS.help': 'After the announcement, until the first key.',
    'field.menu.maxAttempts': 'Attempts',
    'field.menu.maxAttempts.help':
      'How often the announcement repeats when nothing or an unassigned key is pressed.',
    'field.menu.allowExtensionDialing': 'Dialling extensions',
    'field.menu.fallbackTarget': 'Fallback',
    'field.menu.targets': 'Key assignments',

    'field.audio.upload': 'File',
    'field.audio.kind': 'What for?',
    'field.audio.label': 'Label',

    'field.oooRule.startsAt': 'Start',
    'field.oooRule.expiresAt': 'End',
    'field.oooRule.target': 'Meanwhile, calls go to',
    'field.oooRule.active': 'Switched on',

    'field.openingHours.active': 'In use',
    'field.openingHours.intervals': 'Open',
    'field.openingHours.closedTarget': 'When closed, calls go to',
    'field.openingHours.closedTarget.help':
      'Applies to calls from outside and forwarded calls, not to internal calls.',

    'confirm.ringGroups.delete.title': 'Delete ring group {name}?',
    'confirm.ringGroups.delete.body':
      'Extension {ext} becomes free. You can undo the deletion for {days} days.',
    'confirm.ringGroups.delete.action': 'Delete',
    'confirm.ringGroups.deleteAnytime.title': 'Delete ring group {name}?',
    'confirm.ringGroups.deleteAnytime.body':
      'Extension {ext} becomes free. You can undo the deletion at any time.',
    'confirm.ringGroups.deleteAnytime.action': 'Delete',
    'confirm.menus.delete.title': 'Delete phone menu {name}?',
    'confirm.menus.delete.body': 'You can undo the deletion for {days} days.',
    'confirm.menus.delete.action': 'Delete',
    'confirm.menus.deleteAnytime.title': 'Delete phone menu {name}?',
    'confirm.menus.deleteAnytime.body':
      'You can undo the deletion at any time.',
    'confirm.menus.deleteAnytime.action': 'Delete',
    'confirm.audio.delete.title': 'Delete {name}?',
    'confirm.audio.delete.body': 'You can undo the deletion for {days} days.',
    'confirm.audio.delete.action': 'Delete',
    'confirm.audio.deleteAnytime.title': 'Delete {name}?',
    'confirm.audio.deleteAnytime.body':
      'You can undo the deletion at any time.',
    'confirm.audio.deleteAnytime.action': 'Delete',
    'confirm.ooo.delete.title': 'Delete the absence?',
    'confirm.ooo.delete.body':
      'The absence of {name} is deleted. You can undo this for {days} days.',
    'confirm.ooo.delete.action': 'Delete',
    'confirm.ooo.deleteAnytime.title': 'Delete the absence?',
    'confirm.ooo.deleteAnytime.body':
      'The absence of {name} is deleted. You can undo this at any time.',
    'confirm.ooo.deleteAnytime.action': 'Delete',
    'confirm.hours.delete.title': 'Remove own opening hours?',
    'confirm.hours.delete.body':
      "{name} then follows the company's opening hours again. You can undo this for {days} days.",
    'confirm.hours.delete.action': 'Remove',
    'confirm.hours.deleteAnytime.title': 'Remove own opening hours?',
    'confirm.hours.deleteAnytime.body':
      "{name} then follows the company's opening hours again. You can undo this at any time.",
    'confirm.hours.deleteAnytime.action': 'Remove',
    'confirm.hours.deleteTenant.title': "Remove the company's opening hours?",
    'confirm.hours.deleteTenant.body':
      'Calls then come through around the clock, except where own hours apply. You can undo this for {days} days.',
    'confirm.hours.deleteTenant.action': 'Remove',
    'confirm.hours.deleteTenantAnytime.title':
      "Remove the company's opening hours?",
    'confirm.hours.deleteTenantAnytime.body':
      'Calls then come through around the clock, except where own hours apply. You can undo this at any time.',
    'confirm.hours.deleteTenantAnytime.action': 'Remove',

    'errors.groups.required': 'Please fill this in.',
    'errors.groups.range': 'Please enter a whole number from {min} to {max}.',
    'errors.groups.positive': 'Please enter a whole number of at least 1.',
    'errors.groups.e164':
      '"{value}" is not a valid number in international format (e.g. +4989123456).',
    'errors.groups.sipUser':
      'The SIP user may contain letters, digits and . _ ~ + - only (at most 64 characters).',
    'errors.groups.adminTarget': 'Only an admin can set this destination.',
    'errors.groups.audioKind':
      'This audio file does not fit here; it needs one of the kind "{kind}".',
    'errors.groups.audioKindUnknown': 'Please choose what the file is for.',
    'errors.groups.uploadType': 'Only WAV and MP3 files are supported.',
    'errors.groups.strategy': 'Please choose a ring order.',
    'errors.groups.duplicateMember': 'A member is listed twice.',
    'errors.groups.noExtension':
      'This person has no extension and cannot ring. Give them one first:',
    'errors.groups.noFreeExtension': 'There are no free extensions left.',
    'errors.groups.logLevel': 'Unknown diagnostics level.',
    'errors.groups.logLevelExpiry': 'An expiry needs a diagnostics level.',
    'errors.groups.condition': 'Unknown condition.',
    'errors.groups.duplicateCondition': 'Only one rule per condition.',
    'errors.groups.digits':
      '“{digits}” is not valid: only digits, * and # are allowed.',
    'errors.groups.duplicateDigits':
      'The key sequence {digits} is already assigned.',
    'errors.groups.datetime': 'Please enter a valid date and time.',
    'errors.groups.oooOrder': 'The end must be after the start.',
    'errors.groups.oooOverlap':
      'This period overlaps another absence that is switched on.',
    'errors.groups.weekday': 'Unknown weekday {weekday}.',
    'errors.groups.hoursTime': 'Invalid time in {range}.',
    'errors.groups.hoursMidnight':
      '{range} crosses midnight; split the period in two.',
    'errors.groups.hoursDuplicate':
      'Two periods start on the same day at {opens}.',
    'errors.groups.noSchedule': 'No own opening hours are set here.'
  }
} satisfies Messages;
