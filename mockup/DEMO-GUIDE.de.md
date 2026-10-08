# Zamfono-Mockup: Leitfaden für Vorführende

Dieser Leitfaden ist für alle, die das Zamfono-Mockup Interessenten vorführen oder Kolleg:innen
durchführen. Er beschreibt die Vorbereitung, die Personen und Daten der Demo, fertige Abläufe, jedes
vorbereitete Mucki-Gespräch, worauf man hinweisen sollte und was zu tun ist, wenn etwas vom Plan
abweicht.

Das Mockup ist ein klickbares Modell der Zamfono-Oberfläche für Verwaltung und Selbstbedienung. Es
läuft vollständig im Browser: kein Server, keine echte Telefonie, keine echten E-Mails. Alles, was
Besucher anklicken, verhält sich so wie die Zamfono-API, samt Berechtigungen, Rückfragen,
Fehlermeldungen und Rückgängig. Die Demo zeigt also ehrlich, was das Produkt kann.

## 1. Vor der Demo

| Prüfen                | Warum                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mockup öffnen         | https://demo.zamfono.com in einem aktuellen Browser. Der Leitfaden steckt in der Demo-Leiste (**Leitfaden**) und unter https://demo.zamfono.com/guide.                                                                                                                                                                                                       |
| **Demo zurücksetzen** | In der dunklen Demo-Leiste ganz oben. Startet mit einer frischen Brandt & Partner samt heutigem Anrufverlauf. Vor jeder Demo ausführen.                                                                                                                                                                                                                      |
| Sprache               | Profilmenü → **Sprache** DE/EN. Deutsch ist voreingestellt und die Hauptsprache der Abläufe.                                                                                                                                                                                                                                                                 |
| Darstellung           | Profilmenü → **Darstellung**. Hell wirkt am Beamer meist besser, Dunkel sieht am Laptop sehr gut aus.                                                                                                                                                                                                                                                        |
| Fensterbreite         | Ab 1280 px stehen Seitenleiste, Seite und Mucki nebeneinander. Unter 1100 px legt sich Mucki über die Seite, unter 760 px erscheint die Handy-Ansicht.                                                                                                                                                                                                       |
| Ton                   | Mailbox-Nachrichten und Gesprächsaufnahmen spielen echte (synthetische) deutsche Sprache ab. Lautsprecher prüfen.                                                                                                                                                                                                                                            |
| Tageszeit             | Die Anrufverteilung folgt der Uhr: Eingehende Anrufe werden zu den Öffnungszeiten durchgestellt (Mo–Do 08:00–12:30 und 13:30–17:30, Fr 08:00–14:00, Berlin), außerhalb davon hören sie die Ansage „geschlossen“ oder landen auf einer Mailbox. Um unabhängig von der echten Uhrzeit eine Situation zu zeigen, einen **Demo-Zeitpunkt** wählen (Abschnitt 2). |

**Tipp:** Nur der sichtbare Tab simuliert Anrufe. Zwei Tabs nebeneinander (etwa Jonas und Mira)
teilen sich dieselben Firmendaten, und jeder bleibt bei seiner angemeldeten Person. Das ergibt einen
schönen Moment „Admin ändert es, die Mitarbeiterin sieht es“.

## 2. Die Demo-Leiste

Die gestreifte Leiste ganz oben gehört nicht zum Produkt; das dem Publikum auch so sagen.

| Bedienelement                                              | Was es tut                                                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Lea · Inhaberin / Jonas · Admin / Mira · Mitarbeiterin** | Wechselt sofort die angemeldete Person, ohne Abmelden. Jede Person hat ihren eigenen Mucki-Chat.                               |
| Uhr                                                        | Datum und Uhrzeit der Demo. Limettengrün, solange ein Demo-Zeitpunkt gesetzt ist. Öffnet das Menü **Demo-Zeitpunkt** (unten).  |
| **Leitfaden**                                              | Öffnet diesen Leitfaden neben dem Mockup. Seine Links (`/history?as=jonas`) öffnen die genannte Seite als die genannte Person. |
| **Live-Simulation pausieren**                              | Hält eingehende Anrufe, Statuswechsel und andere Live-Ereignisse an, etwa während man eine Seite erklärt.                      |
| **Demo zurücksetzen**                                      | Stellt die Ausgangsdaten wieder her und löscht alle Mucki-Gespräche.                                                           |
| **Abmelden**                                               | Zurück zur Anmeldung.                                                                                                          |
| Pfeil                                                      | Klappt die Leiste zu einem kleinen Reiter ein.                                                                                 |

### Demo-Zeitpunkte

Über die Uhr in der Demo-Leiste startet die Demo zu einem gewählten Zeitpunkt neu; die Uhr läuft von
dort weiter, und Anrufverlauf, Mailbox-Nachrichten und Backups passen zu diesem Zeitpunkt. **Demo
zurücksetzen** springt an den Anfang des gerade gewählten Zeitpunkts zurück.

| Zeitpunkt               | Datum und Uhrzeit                   | Zeigt                                                                                                        |
| ----------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Jetzt**               | Die echte Uhrzeit                   | Was gerade tatsächlich gilt.                                                                                 |
| **Bürotag, 10:30**      | Der kommende Dienstag, 10:30        | Ein voller Büromorgen: Gruppen klingeln, Kolleg:innen nehmen ab. Der beste Startpunkt für einen Rundgang.    |
| **Feierabend, 19:00**   | Derselbe Dienstag, 19:00            | Geschlossen: Die Hauptnummer spielt die Ansage „geschlossen“, die Hotline geht auf die Mailbox des Supports. |
| **Zwischen den Jahren** | 29. Dezember, 10:00                 | Die Betriebsruhe gilt: Jeder Anruf bei der Kanzlei hört die Feiertagsansage.                                 |
| **Felix im Urlaub**     | Mittwoch seiner Urlaubswoche, 11:00 | Seine Abwesenheit gilt: Anrufe auf seine Durchwahl klingeln bei Daniel; der Verlauf zeigt, warum.            |

Alle Zeitpunkte außer **Jetzt** sind deutlich markiert: Die Uhr wird limettengrün, damit niemand die
Demo-Zeit für die echte hält.

Direktlinks legen Person und Expertenmodus fest, praktisch für vorbereitete Lesezeichen:
`/history?as=jonas`, `/settings?as=lea&expert=1`, `/me/forwarding?as=mira`.

## 3. Die Besetzung

**Brandt & Partner Steuerberatung, München**: eine Steuerkanzlei mit 14 Personen.

| Person             | Rolle          | Durchwahl | Gut für                                                                                                                 |
| ------------------ | -------------- | --------- | ----------------------------------------------------------------------------------------------------------------------- |
| Lea Brandt         | Inhaberin      | 101       | Einstellungen nur für Inhaber, Updates, SSO, Ringotel, Massenänderungen. Meldet sich mit Authenticator oder Passkey an. |
| Jonas Weber        | Admin          | 102       | Die Sicht der Büroleitung: Personen, Gruppen, Zeiten, Rufnummern, Fehlersuche. Authenticator.                           |
| Mira Kovač         | Mitarbeiterin  | 103       | Selbstbedienung: Weiterleitung, Urlaub, Mailbox, Nicht stören. Kein zweiter Faktor.                                     |
| Dr. Felix Hartmann | Inhaber        | 104       | Zweiter Inhaber; seine Gespräche werden aufgezeichnet; hat Passkeys; Urlaub in zwei Wochen.                             |
| Empfang            | Mitarbeiter:in | 100       | Ein Empfangstelefon ohne E-Mail; als Einziges ohne Ringotel-App.                                                        |
| Markus Huber       | Mitarbeiter    | 120       | Meist im Gespräch; seine Durchwahl ist der geplante Konflikt in der Massenanlage-Demo.                                  |
| Petra Engel        | Mitarbeiterin  | –         | Nur E-Mail, keine Durchwahl: kann sich anmelden, hat kein Telefon.                                                      |

Außerdem: Sophie Lang (106), Daniel Roth (107, wird aufgezeichnet), Aylin Demir (108), Tobias
Neumann (109, auf Nicht stören), Laura Fischer (111), Katrin Wolf (113), Nina Schreiber (114, App
nicht angemeldet).

**Rufnummern und Anrufverteilung**

- Hauptnummer **+49 89 4520 0** → Sprachmenü **Hauptmenü** (1 Beratung, 2 Buchhaltung, 3 Support,
  0 Empfang).
- Durchwahlen im Block +49 89 4520 xxx; **Mandanten-Hotline +49 89 4520 500** → Rufgruppe
  **Mandanten-Support (004)**.
- Rufgruppen Empfang (001), Beratung (002, wird aufgezeichnet), Buchhaltung (003), Mandanten-Support
  (004, eigene Zeiten Mo–Fr 09–17, Mailbox).
- Ein Trunk, **Nordwind SIP** (TLS, SRTP), zugleich der Notruf-Trunk.
- Betriebsruhe zwischen den Jahren (28.12.–2.1.) mit Ansage; Felix' Urlaub in zwei Wochen.

## 4. Abläufe

Nach Publikum und verfügbarer Zeit wählen. Jeder Schritt sagt, was man anklickt und was man sagt.

### A. Erster Eindruck (3 Minuten)

1. **Anmeldung.** Markenbereich mit dem Firmennamen, Anmeldung mit Microsoft und der dunkle Bereich
   **Demo-Zugänge**. **Jonas Weber** anklicken.
2. **Zweiter Faktor.** Darauf hinweisen, dass Admins und Inhaber sich mit zwei Faktoren anmelden
   müssen. Der Demo-Authenticator zeigt einen laufenden Code: **Code einsetzen**.
3. **Übersicht.** Live-Kacheln: verpasste Anrufe, neue Mailbox-Nachrichten, geparkte Anrufe, laufende
   Gespräche. Admins sehen zusätzlich laufende Anrufe, die Telefonleitung, den Systemzustand und das
   heutige Anrufaufkommen. Ein paar Sekunden stehen lassen: Anrufe klingeln, Personen wechseln ihren
   Status, die Glocke zählt Ereignisse.

### B. Rundgang der Büroleitung (10 Minuten, Jonas)

1. **Benutzer → Benutzer anlegen.** Name, E-Mail, Durchwahl (die nächste freie wird vorgeschlagen).
   Der einmalige Link zum Passwort-Setzen erscheint genau einmal; gleich die Ringotel-App
   hinzufügen.
2. **Rufgruppe Mandanten-Support.** Mitglieder, Klingelstrategie, Zeiten, Mailbox, Wartemusik. Reiter
   **Weiterleitung**: was passiert, wenn niemand abnimmt.
3. **Öffnungszeiten.** Im Wochenraster einen Block ziehen, seine Länge ändern, ihn für genaue Zeiten
   anklicken. Mit **Abwesenheit** eine Schließung eintragen: Sie erscheint in der Zeitleiste und wird
   abgelehnt, wenn sie sich mit einer anderen überschneidet.
4. **Sprachmenüs → Hauptmenü.** Der Tastenfeld-Editor: Jede Taste führt zu einer Person, Gruppe,
   Mailbox oder Ansage.
5. **Rufnummern.** Hauptnummer, Durchwahlen, Nummernblock; Leas Nummer löschen und die Ablehnung
   zeigen, die nennt, wer sie noch verwendet.
6. **Änderungsprotokoll.** Jede gerade gemachte Änderung, von wem und auf welchem Weg; bei jeder
   **Rückgängig**.

### C. „Warum ist der Anruf auf der Mailbox gelandet?“ (5 Minuten, Jonas)

Der stärkste Einzelmoment der Demo.

1. **Anrufverlauf** → der Anruf von **+49 171 5550123 um 10:15** auf der Hotline (am letzten
   Werktag; ab 10:20 Uhr heute).
2. Der senkrechte Verlauf liest sich wie eine Geschichte: Nummer erkannt, Support geöffnet, Sophie
   hat nicht abgenommen, Mira war im Gespräch, bei Nina ist kein Telefon angemeldet, Tobias ist auf
   Nicht stören, 45 s Klingelzeit insgesamt, die Regel „keine Antwort“, die Mailbox des Supports. Die
   Gesprächsqualität wird je Seite angezeigt.
3. **Expertenmodus** in der oberen Leiste einschalten: Das rohe Anrufprotokoll und der
   SIP-Nachrichtenverlauf erscheinen.
4. Mucki dieselbe Frage stellen (Wortlaut in Abschnitt 5): Mucki liest denselben Verlauf, erklärt
   ihn in einfachen Worten und spielt die Mailbox-Nachricht von Herrn Yilmaz ab.

### D. Selbstbedienung am Handy (5 Minuten, Mira)

Zu **Mira** wechseln und das Fenster unter 760 px verkleinern oder den Link auf einem echten Handy
öffnen.

1. Die Reiterleiste unten: Übersicht, Anrufe, Mailbox, Ich, Mucki.
2. **Mailbox**: die Nachricht von Elif Kaya abspielen, als gehört markieren.
3. **Ich → Weiterleitung**: Regeln als Karten, „nach 20 Sekunden aufs Handy“.
4. **Ich → Abwesenheit & Zeiten**: den Urlaub nächste Woche eintragen.
5. Zeigen, was sie nicht kann: keine Admin-Seiten im Menü, keine Gesprächsaufnahmen (auch nicht die
   eigenen), keine SIP-Ziele für Weiterleitungen. Mucki erklärt auf Nachfrage dieselben Grenzen.

### E. Die Inhaberin (5 Minuten, Lea)

1. **Einstellungen**: Lea bearbeitet Mail-Relay, SSO, Notrufnummern und Aufbewahrungsfristen. Zu Jonas
   wechseln und dieselben Karten als reinen Text zeigen, Zugangsdaten ausgeblendet.
2. **System & Updates**: Version 0.5.0 ist verfügbar. Ein Update braucht ein erfolgreiches Backup aus
   der letzten Stunde: **Zu den Backups** → Backup starten (etwa 5 s) → **Jetzt aktualisieren** →
   Wartungshinweis (etwa 6 s) → 0.5.0. Oder Mucki machen lassen (Wortlaut 7).
3. **KI & API**: Claude Code oder Codex mit einem Befehl verbinden; Webhooks für das CRM.

### F. Expertenmodus (2 Minuten, beliebige Admin-Person)

Der Schalter **Expertenmodus** in der oberen Leiste zeigt jede Einstellung, die das System hat,
markiert mit **Experte**: Codecs, SIP-Sperrschwellen, Trunk-Timer und TLS-Optionen, IP-Freigaben für
Geräte, Diagnosestufen, rohe Anrufprotokolle, SIP-Verläufe, interne IDs und die zusätzliche Seite
**SIP-Schutz**. Ausgeschaltet zeigen dieselben Seiten nur, was eine Büroleitung braucht. Botschaft:
ein Produkt für die Büroleitung und für den IT-Partner.

### G. Feierabend, Feiertage, Urlaub (5 Minuten, Jonas)

1. Uhr in der Demo-Leiste → **Feierabend, 19:00**. **Öffnungszeiten** zeigt die Kanzlei bis
   Mittwochmorgen geschlossen. Ein, zwei Anrufe abwarten, dann **Anrufverlauf** öffnen: Der Verlauf
   zeigt den geschlossenen Zeitplan und dass der Anruf zur Ansage „geschlossen“ oder auf die Mailbox
   des Supports ging.
2. Uhr → **Zwischen den Jahren**: Die Betriebsruhe ist aktiv; Anrufer hören die Feiertagsansage.
3. Uhr → **Felix im Urlaub**: Anrufe auf Felix' Durchwahl gehen an Daniel; seine Benutzerseite zeigt
   die laufende Abwesenheit.
4. Zurück zu **Bürotag, 10:30**, um weiterzumachen.

## 5. Mucki, der Assistent

Mucki ist das korallenfarbene Fenster rechts (am Handy: der Reiter **Mucki**). Mucki handelt als die
angemeldete Person, mit genau ihren Rechten: Alles, was Mucki ändert, erscheint sofort in den Seiten
und im Änderungsprotokoll als „über Mucki“ und lässt sich rückgängig machen. Vor allem, was sich
nicht rückgängig machen lässt oder etwas löscht, erscheint eine Bestätigungskarte; nichts passiert
vor **Bestätigen**.

Gesteuert wird über die Vorschläge (sie wechseln mit Person und Seite) oder frei getippt, auf Deutsch
oder Englisch. Alles außerhalb der vorbereiteten Gespräche bekommt eine freundliche Antwort mit dem,
was Mucki kann. **Neues Gespräch** leert den Chat der aktuellen Person.

| #   | Person | Sagen                                                                                                       | Was passiert                                                                                                                                                                | Hinzeigen auf                                                     |
| --- | ------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | Jonas  | „Neue Mitarbeiterin anlegen“ → Vorschlag „Tom Becker, tom.becker@brandt-partner.de, Durchwahl 105, mit App“ | Legt Tom an, zeigt seinen einmaligen Passwort-Link, fügt die Ringotel-App hinzu.                                                                                            | **Zeig mal** springt zu Tom und hebt die Zeile hervor.            |
| 2   | Jonas  | „Schließ den Support am 24.–26.12., Anrufe auf die Mailbox“                                                 | Prüft auf überschneidende Schließungen und plant dann die Schließung für den Mandanten-Support.                                                                             | Der Reiter **Zeiten & Abwesenheit** der Rufgruppe.                |
| 3   | Jonas  | „Mach das rückgängig“                                                                                       | Findet die eigene letzte Änderung im Änderungsprotokoll und macht sie rückgängig.                                                                                           | Änderungsprotokoll: der ursprüngliche Eintrag und das Rückgängig. |
| 4   | Jonas  | „Warum ist der Anruf von +49 171 5550123 um 10:15 auf der Mailbox gelandet?“                                | Liest den Anruf und erklärt den Verlauf in einfachen Worten; bietet an, die Nachricht abzuspielen.                                                                          | Die Detailseite des Anrufs (Zeig mal).                            |
| 5   | Jonas  | „Ist unser Trunk ok?“                                                                                       | Prüft die Leitung; ist sie ausgefallen, bietet Mucki an, sie neu anzumelden, und meldet, wenn sie wieder da ist.                                                            | Am besten direkt nach dem Leitungsausfall (Abschnitt 7).          |
| 6   | Lea    | „8 neue Leute aus einer Liste anlegen“ → Vorschlag einfügen                                                 | Legt sieben Personen mit Fortschrittskarte an; eine Zeile will Markus' Durchwahl 120 und wird gemeldet, dann bietet Mucki eine freie Durchwahl an.                          | Die Benutzerliste mit den neuen Personen.                         |
| 7   | Lea    | „Update Zamfono“                                                                                            | Prüft die Version, findet kein aktuelles Backup, startet eines, wartet, fragt nach Bestätigung für das Update und meldet dann 0.5.0.                                        | System & Updates.                                                 |
| 8   | Lea    | „Leite die Hotline an unseren KI-Telefonagenten weiter“                                                     | Fragt nach der Adresse des Agenten (Vorschlag `sip.voiceagent.example`), legt eine SIP-Verbindung „KI-Telefonagent“ an und leitet die Hotline samt Anrufer-Headern dorthin. | Rufnummern: Die Hotline geht jetzt an den KI-Agenten.             |
| 9   | Mira   | „Leite meine Anrufe nach 20 Sekunden aufs Handy“                                                            | Fragt nach der Handynummer (Vorschlag), stellt 20 s Klingelzeit und die Weiterleitung „keine Antwort“ ein.                                                                  | Ich → Weiterleitung.                                              |
| 10  | Mira   | „Ich bin nächste Woche im Urlaub“                                                                           | Fragt, wohin Anrufe gehen sollen (Mailbox, Sophie, Empfang), und plant Montag bis Samstag.                                                                                  | Ich → Abwesenheit & Zeiten.                                       |
| 11  | Mira   | „Spiel mir die Aufnahme meines letzten Gesprächs vor“                                                       | Lehnt höflich ab: Aufnahmen dürfen nur Admins hören. Bietet stattdessen ihre neueste Mailbox-Nachricht an und spielt sie ab.                                                | Genau diese Rollengrenze ist der Punkt.                           |

Englisch geht auch („Why did the call from +49 171 5550123 at 10:15 go to voicemail?“, „Update
Zamfono“, „I'm on vacation next week“, …). Mit eingeschaltetem **Expertenmodus** zeigen Muckis
Werkzeugkarten genau die aufgerufene Operation mit Eingabe und Ergebnis; gut für ein technisches
Publikum.

## 6. Argumente

- **Nichts zu installieren.** Die Verwaltung läuft im Browser; das Team telefoniert mit der
  Ringotel-App oder einem Tischtelefon.
- **Jede Änderung wird protokolliert und lässt sich rückgängig machen**, ob in der Oberfläche oder
  durch einen KI-Assistenten, mit wer und wie.
- **Rollen, die zu einem kleinen Büro passen**: Inhaber, Admin, Mitarbeitende. Inhaber behalten die
  kritischen Einstellungen; Mitarbeitende verwalten ihr eigenes Telefon und sehen sonst nichts.
- **Erklärt sich selbst.** Der Anrufverlauf beantwortet „Warum ist das passiert?“ ohne Techniker.
- **Ruhig im Alltag, vollständig im Expertenmodus.** Die Büroleitung sieht das Wesentliche, ein
  IT-Partner findet jede Option.
- **KI-Assistent eingebaut**, der als die Person handelt, mit denselben Rechten und demselben
  Sicherheitsnetz; jeder MCP-Client (Claude, Codex) kann sich genauso verbinden.
- **Sicherheit**: Anmeldung mit zwei Faktoren per Authenticator oder Passkeys, Anmeldung mit
  Microsoft, Schutz vor SIP-Angriffen mit automatischen Sperren, Gesprächsaufnahmen nur für Admins.
- **Live**: Status, klingelnde Anrufe, Mailbox-Nachrichten und Leitungszustand aktualisieren sich
  ohne Neuladen.

## 7. Was simuliert ist und wie man sich hilft

| Situation                                                 | Gut zu wissen                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Die Telefonleitung fällt aus                              | Etwa 75 s nach Demostart ist **Nordwind SIP** einmal nicht erreichbar: Laufende externe Gespräche enden als unterbrochen, neue kommen nicht an, intern telefonieren die Kolleg:innen weiter. Für Wortlaut 5 nutzen oder **SIP-Trunks → Neu anmelden**. Nach 5 Minuten erholt sich die Leitung von selbst. |
| Anrufe und Status ändern sich von allein                  | Das ist die Live-Simulation. In der Demo-Leiste pausieren, während man eine volle Seite erklärt.                                                                                                                                                                                                          |
| Stimmen                                                   | Mailbox-Nachrichten und Aufnahmen sind synthetisch, die Anrufer erfunden. Aufnahmen sind stereo: links die Kollegin oder der Kollege, rechts die Gegenseite (im Player umschaltbar).                                                                                                                      |
| Passwörter und Codes                                      | Für die Demo-Zugänge funktioniert jedes Passwort; beliebige sechs Ziffern bestehen den zweiten Faktor (oder **Code einsetzen**).                                                                                                                                                                          |
| E-Mails, Ringotel, Backups, Updates                       | Nichts verlässt den Browser. E-Mails zeigen eine Bestätigung, Backups und Updates dauern ein paar Sekunden und gelingen.                                                                                                                                                                                  |
| Audiodateien                                              | Jede Begrüßung, Mailbox-Ansage, Ansage und Wartemusik spielt ab; ein Klick in die Wellenform springt an die Stelle. Die Wartemusik ist das opsound-Paket, das Zamfono mitliefert (CC BY-SA, im Admin-Handbuch genannt). Uploads spielen, bis die Seite neu geladen wird.                                  |
| Nach dem Ausprobieren sehen die Daten wild aus            | **Demo zurücksetzen**.                                                                                                                                                                                                                                                                                    |
| Ein Tab zeigt eine andere Person als erwartet             | Jeder Tab behält seine eigene Person; die Demo-Leiste oder einen `?as=`-Link verwenden.                                                                                                                                                                                                                   |
| Änderungen sind nach dem Schließen des Browsers weg       | Die Demo speichert ihren Stand im Browser; private Fenster oder gesperrte Website-Daten starten jedes Mal neu. Es funktioniert trotzdem, es merkt sich nur nichts.                                                                                                                                        |
| Mucki wurde unterbrochen (Neuladen mitten in der Antwort) | Die Karte zeigt „Unterbrochen“; nochmals fragen oder **Neues Gespräch** beginnen.                                                                                                                                                                                                                         |

## 8. Fragen von Interessenten

- **„Ist das das echte Produkt?“** Es ist ein klickbares Modell der Zamfono-Oberfläche, gebaut gegen
  die echte API: Regeln, Berechtigungen und Meldungen sind die des Produkts.
- **„Kann ich meine Nummern behalten?“** Die Nummern kommen vom SIP-Anbieter hinter dem Trunk;
  Zamfono verteilt, was der Anbieter liefert, auch Nummernblöcke.
- **„Welche Telefone funktionieren?“** Die Ringotel-App für iOS, Android und Desktop sowie
  gewöhnliche SIP-Tischtelefone (**Telefon hinzufügen** zeigt die Verbindungsdaten).
- **„Wo läuft die KI?“** Mucki nutzt dieselbe Schnittstelle wie jeder KI-Client, angemeldet als die
  Person; Mucki kann nichts, was diese Person nicht könnte.
