/**
 * The sign-in pages (`auth.`), the security page (`security.`) and the refusals of the `auth.*`
 * operations (`errors.auth.`). Wording follows the API's own pages (`packages/api/src/lib/i18n`).
 */
import type { Messages } from '../index.svelte';

export default {
  de: {
    'auth.brand.eyebrow': 'Telefonanlage',
    'auth.brand.tagline':
      'Anrufe, Mailbox, Weiterleitungen und Ihr Team – an einem Ort.',
    'auth.layout.language': 'Sprache',
    'auth.backToLogin': 'Zurück zur Anmeldung',

    'auth.login.title': 'Anmelden',
    'auth.login.subtitle': 'bei {company}',
    'auth.login.email': 'E-Mail',
    'auth.login.emailPlaceholder': 'name@firma.de',
    'auth.login.password': 'Passwort',
    'auth.login.forgot': 'Passwort vergessen?',
    'auth.login.submit': 'Anmelden',
    'auth.login.invalid': 'E-Mail oder Passwort ist falsch.',
    'auth.login.or': 'oder',
    'auth.login.sso': 'Anmelden mit {provider}',

    'auth.verify.title': 'Bestätigen Sie die Anmeldung',
    'auth.verify.subtitle': 'Ihr Konto ist mit einem zweiten Faktor geschützt.',
    'auth.verify.notYou': 'Nicht Sie?',
    'auth.verify.methods': 'Bestätigen mit',
    'auth.verify.method.totp': 'Authenticator-App',
    'auth.verify.method.passkey': 'Passkey',
    'auth.verify.method.recovery': 'Wiederherstellungscode',
    'auth.verify.totpIntro':
      'Geben Sie den 6-stelligen Code aus Ihrer Authenticator-App ein.',
    'auth.verify.codeLabel': 'Code',
    'auth.verify.demoHint': 'Demo: Jeder 6-stellige Code wird akzeptiert.',
    'auth.verify.passkeyIntro':
      'Bestätigen Sie mit Fingerabdruck, Gesichtserkennung, der Bildschirmsperre oder Ihrem Sicherheitsschlüssel.',
    'auth.verify.usePasskey': 'Passkey verwenden',
    'auth.verify.recoveryIntro':
      'Haben Sie Ihr Gerät nicht zur Hand? Jeder Wiederherstellungscode meldet Sie einmal an. Noch {count} unbenutzt.',
    'auth.verify.recoveryLabel': 'Wiederherstellungscode',
    'auth.verify.recoveryDemoHint':
      'Demo: Jeder Code im Format ABCD-EFGH-IJKL-MNOP wird akzeptiert und verbraucht.',
    'auth.verify.submit': 'Bestätigen',

    'auth.enrol.title': 'Zwei-Faktor-Anmeldung einrichten',
    'auth.enrol.intro':
      'Ihr Konto braucht eine Zwei-Faktor-Anmeldung. Richten Sie sie jetzt ein – das dauert eine Minute.',
    'auth.enrol.qrLabel': 'QR-Code für Ihre Authenticator-App',
    'auth.enrol.step1':
      'Öffnen Sie eine Authenticator-App, etwa Microsoft Authenticator oder Google Authenticator.',
    'auth.enrol.step2': 'Scannen Sie diesen QR-Code.',
    'auth.enrol.step3':
      'Geben Sie den 6-stelligen Code ein, den die App anzeigt.',
    'auth.enrol.secretLabel':
      'Oder geben Sie diesen Schlüssel von Hand in der App ein:',
    'auth.enrol.codeLabel': 'Code aus der App',
    'auth.enrol.confirm': 'Bestätigen',
    'auth.enrol.passkeyOr':
      'Oder richten Sie stattdessen einen Passkey ein, mit diesem Gerät oder einem Sicherheitsschlüssel:',

    'auth.passkey.name': 'Name dieses Passkeys',
    'auth.passkey.namePlaceholder': 'Passkey',
    'auth.passkey.add': 'Passkey einrichten',
    'auth.passkey.promptSignIn': 'Mit Passkey anmelden',
    'auth.passkey.promptCreate': 'Passkey erstellen',
    'auth.passkey.promptHint':
      'Fingerabdruck, Gesicht oder Bildschirmsperre verwenden',
    'auth.passkey.promptDone': 'Bestätigt',

    'auth.codes.title': 'Wiederherstellungscodes',
    'auth.codes.intro':
      'Bewahren Sie diese Codes sicher auf. Jeder meldet Sie einmal an, falls Sie Ihren Authenticator oder Passkey verlieren.',
    'auth.codes.once': 'Sie werden nur einmal angezeigt.',
    'auth.codes.download': 'Herunterladen (.txt)',
    'auth.codes.saved': 'Ich habe meine Wiederherstellungscodes gespeichert',
    'auth.codes.continue': 'Weiter',

    'auth.sso.pickTitle': 'Konto auswählen',
    'auth.sso.pickSubtitle': 'um mit „{app}“ fortzufahren',
    'auth.sso.appName': 'Telefonanlage {company}',
    'auth.sso.demoNote':
      'Demo: simuliert die Anmeldeseite des Identitätsanbieters. Mit SSO entfällt der zweite Schritt – dort gilt die Zwei-Faktor-Anmeldung des Anbieters.',

    'auth.demo.title': 'Demo-Zugänge',
    'auth.demo.stepTitle': 'Demo-Hilfen',
    'auth.demo.intro': 'Mit einem Klick anmelden – jedes Passwort passt.',
    'auth.demo.method.totp': 'Authenticator',
    'auth.demo.method.passkeys': '{count}× Passkey',
    'auth.demo.method.none': 'ohne Zwei-Faktor',
    'auth.demo.tryEnrol':
      'Ersteinrichtung der Zwei-Faktor-Anmeldung ansehen (als {name})',
    'auth.demo.pages': 'Weitere Seiten',
    'auth.demo.consentPage': 'Zustimmung (MCP)',
    'auth.demo.authenticator': 'Authenticator-App auf dem Handy',
    'auth.demo.useCode': 'Code einsetzen',
    'auth.demo.secondsLeft': 'Noch {seconds} Sekunden gültig',
    'auth.demo.anyCode':
      'Demo: Jeder 6-stellige Code wird akzeptiert; Passkeys werden simuliert.',
    'auth.demo.codesNote':
      'Demo: Die Codes sind zufällig erzeugt. Nach dem Haken bei „gespeichert“ geht es weiter.',
    'auth.demo.backToPersonas': 'Zurück zu den Demo-Zugängen',

    'auth.toast.welcome': 'Willkommen, {name}',
    'auth.toast.mailed': 'Benachrichtigung per E-Mail an {email} gesendet.',
    'auth.toast.totpAdded': 'Authenticator-App eingerichtet',
    'auth.toast.totpReplaced': 'Authenticator-App ersetzt',
    'auth.toast.totpRemoved': 'Authenticator-App entfernt',
    'auth.toast.passkeyAdded': 'Passkey „{name}“ eingerichtet',
    'auth.toast.passkeyRemoved': 'Passkey „{name}“ entfernt',

    'auth.forgot.title': 'Passwort vergessen',
    'auth.forgot.intro':
      'Geben Sie Ihre E-Mail-Adresse ein, wir senden Ihnen einen Link zum Setzen eines neuen Passworts.',
    'auth.forgot.submit': 'Link senden',
    'auth.forgot.sent':
      'Falls zu dieser Adresse ein Konto existiert, ist ein Link unterwegs.',
    'auth.forgot.validity': 'Der Link ist eine Stunde gültig.',

    'auth.setPassword.title': 'Passwort setzen',
    'auth.setPassword.password': 'Neues Passwort',
    'auth.setPassword.show': 'Passwort anzeigen',
    'auth.setPassword.hide': 'Passwort verbergen',
    'auth.setPassword.rule': 'Mindestens {min} Zeichen',
    'auth.setPassword.note':
      'Mit dem neuen Passwort werden Sie auf allen Geräten abgemeldet.',
    'auth.setPassword.submit': 'Passwort setzen',
    'auth.setPassword.success': 'Ihr Passwort wurde gesetzt.',
    'auth.setPassword.toLogin': 'Weiter zur Anmeldung',
    'auth.setPassword.invalid':
      'Dieser Link ist abgelaufen oder wurde bereits verwendet.',
    'auth.setPassword.requestNew': 'Neuen Link anfordern',
    'auth.setPassword.tooShort':
      'Das Passwort muss mindestens {min} Zeichen lang sein.',

    'auth.consent.pageTitle': 'Zugriff erlauben',
    'auth.consent.title': '{client} möchte auf {company} zugreifen',
    'auth.consent.actsAs': 'handelt als',
    'auth.consent.canTitle': 'Was {client} dann kann',
    'auth.consent.can.owner':
      'Alles, was Sie als Inhaber:in in der Telefonanlage dürfen: Benutzer, Rufnummern, Weiterleitungen und alle Einstellungen lesen und ändern.',
    'auth.consent.can.admin':
      'Alles, was Sie als Admin in der Telefonanlage dürfen: Benutzer, Rufgruppen, Rufnummern, Weiterleitungen und Einstellungen lesen und ändern.',
    'auth.consent.can.user':
      'Alles, was Sie selbst in der Telefonanlage dürfen: Ihre Anrufe und Mailbox lesen, Ihre Weiterleitungen und Abwesenheiten ändern.',
    'auth.consent.can.role':
      'Es gilt immer Ihre aktuelle Rolle: Ändert sie sich, ändert sich auch, was {client} darf.',
    'auth.consent.can.audit':
      'Jede Änderung wird im Änderungsprotokoll festgehalten, mit {client} als Urheber.',
    'auth.consent.redirect': 'Danach geht es zurück zu',
    'auth.consent.approve': 'Zustimmen',
    'auth.consent.deny': 'Ablehnen',
    'auth.consent.approved': '{client} ist verbunden',
    'auth.consent.denied': 'Zugriff für {client} abgelehnt',

    'auth.error.title': 'Problem bei der Anmeldung',
    'auth.error.expired':
      'Dieser Link ist abgelaufen. Bitte versuchen Sie es erneut.',
    'auth.error.noUser': 'Kein Konto passt zu dieser Anmeldung.',
    'auth.error.noPassword':
      'Legen Sie zuerst über den zugesandten Link Ihr Passwort fest und melden Sie sich dann an.',
    'auth.error.domain':
      'Ihre E-Mail-Domain ist hier nicht zur Anmeldung berechtigt.',
    'auth.error.unverifiedEmail':
      'Ihr Identitätsanbieter hat diese E-Mail-Adresse nicht bestätigt.',
    'auth.error.issuer':
      'Diese Anmeldung stammt vom falschen Identitätsanbieter.',
    'auth.error.audience':
      'Diese Anmeldung wurde für eine andere Anwendung ausgestellt.',
    'auth.error.signature': 'Diese Anmeldung konnte nicht überprüft werden.',
    'auth.error.nonce': 'Diese Anmeldung konnte nicht überprüft werden.',
    'auth.error.generic': 'Bei der Anmeldung ist ein Fehler aufgetreten.',

    'auth.done.title': 'Sie sind angemeldet',
    'auth.done.message': 'Sie sind bei {company} angemeldet.',
    'auth.done.mcpHint': 'Verbinden Sie einen MCP-Client mit:',
    'auth.done.toApp': 'Zur Telefonanlage',
    'auth.done.security': 'Zwei-Faktor-Anmeldung verwalten',

    'security.gate.title': 'Zwei-Faktor-Anmeldung',
    'security.gate.intro':
      'Melden Sie sich erneut an, um zu verwalten, wie Sie Ihre Anmeldungen bestätigen. Danach bleibt diese Seite 10 Minuten offen.',
    'security.gate.demoHint': 'Demo: Jedes Passwort passt.',
    'security.session.signedInAs':
      'Angemeldet als {email} für die nächsten 10 Minuten.',
    'security.session.left': 'Noch {time} Minuten',
    'security.session.lock': 'Sperren',
    'security.required':
      'Ihr Konto muss mindestens einen zweiten Faktor behalten.',
    'security.requiredWhy.owner': 'Das gilt für alle Inhaber:innen.',
    'security.requiredWhy.admin': 'Das gilt für alle Admins.',
    'security.requiredWhy.all': 'Das gilt in dieser Firma für alle.',
    'security.lastMethodHint':
      'Ihr letzter zweiter Faktor: Richten Sie einen weiteren ein, bevor Sie diesen entfernen.',
    'security.lastUsed': 'zuletzt verwendet am {date}',
    'security.neverUsed': 'nie verwendet',
    'security.passkeys.title': 'Passkeys',
    'security.passkeys.description':
      'Anmelden per Fingerabdruck, Gesicht oder Sicherheitsschlüssel – ohne Code abzutippen.',
    'security.passkeys.empty': 'Noch keine Passkeys.',
    'security.passkeys.added': 'eingerichtet am {date}',
    'security.totp.title': 'Authenticator-App',
    'security.totp.description':
      'Ein 6-stelliger Code, der alle 30 Sekunden wechselt.',
    'security.totp.on': 'Eingerichtet',
    'security.totp.off': 'Nicht eingerichtet',
    'security.totp.start': 'Authenticator-App einrichten',
    'security.totp.replace': 'Authenticator-App ersetzen',
    'security.totp.remove': 'Authenticator-App entfernen',
    'security.totp.setupIntro':
      'Scannen Sie den QR-Code mit einer Authenticator-App und geben Sie den Code ein, den sie anzeigt.',
    'security.totp.replaceIntro':
      'Die bisherige App gilt nicht mehr, sobald Sie den ersten Code der neuen bestätigen.',
    'security.codes.title': 'Wiederherstellungscodes',
    'security.codes.description':
      'Für den Notfall, wenn Handy und Passkey nicht zur Hand sind. Jeder Code gilt einmal.',
    'security.codes.left': '{count} unbenutzt',
    'security.codes.regenerate': 'Neue Wiederherstellungscodes erzeugen',
    'security.codes.regenerateNote':
      'Die bisherigen Codes gelten danach nicht mehr.',
    'security.codes.regenerated': 'Neue Wiederherstellungscodes erzeugt',
    'security.codes.done': 'Fertig',
    'security.codes.hide': 'Codes ausblenden',

    'errors.auth.invalidCode': 'Falscher Code.',
    'errors.auth.passkeyFailed': 'Der Passkey konnte nicht geprüft werden.',
    'errors.auth.lastMethod':
      'Ihr Konto muss einen zweiten Faktor behalten: Richten Sie einen weiteren ein, bevor Sie diesen entfernen.',
    'errors.auth.codesNeedMethod':
      'Richten Sie zuerst eine Authenticator-App oder einen Passkey ein.'
  },
  en: {
    'auth.brand.eyebrow': 'Phone system',
    'auth.brand.tagline':
      'Calls, voicemail, forwarding and your team – in one place.',
    'auth.layout.language': 'Language',
    'auth.backToLogin': 'Back to sign in',

    'auth.login.title': 'Sign in',
    'auth.login.subtitle': 'to {company}',
    'auth.login.email': 'E-mail',
    'auth.login.emailPlaceholder': 'name@company.com',
    'auth.login.password': 'Password',
    'auth.login.forgot': 'Forgot your password?',
    'auth.login.submit': 'Sign in',
    'auth.login.invalid': 'Incorrect e-mail or password.',
    'auth.login.or': 'or',
    'auth.login.sso': 'Sign in with {provider}',

    'auth.verify.title': 'Confirm it’s you',
    'auth.verify.subtitle': 'Your account is protected by a second factor.',
    'auth.verify.notYou': 'Not you?',
    'auth.verify.methods': 'Confirm with',
    'auth.verify.method.totp': 'Authenticator app',
    'auth.verify.method.passkey': 'Passkey',
    'auth.verify.method.recovery': 'Recovery code',
    'auth.verify.totpIntro':
      'Enter the 6-digit code from your authenticator app.',
    'auth.verify.codeLabel': 'Code',
    'auth.verify.demoHint': 'Demo: any 6-digit code is accepted.',
    'auth.verify.passkeyIntro':
      'Confirm with your fingerprint, face, screen lock or security key.',
    'auth.verify.usePasskey': 'Use a passkey',
    'auth.verify.recoveryIntro':
      'Don’t have your device at hand? Each recovery code signs you in once. {count} unused.',
    'auth.verify.recoveryLabel': 'Recovery code',
    'auth.verify.recoveryDemoHint':
      'Demo: any code in the format ABCD-EFGH-IJKL-MNOP is accepted and used up.',
    'auth.verify.submit': 'Confirm',

    'auth.enrol.title': 'Set up two-factor sign-in',
    'auth.enrol.intro':
      'Your account needs two-factor sign-in. Set it up now – it takes a minute.',
    'auth.enrol.qrLabel': 'QR code for your authenticator app',
    'auth.enrol.step1':
      'Open an authenticator app, such as Microsoft Authenticator or Google Authenticator.',
    'auth.enrol.step2': 'Scan this QR code.',
    'auth.enrol.step3': 'Enter the 6-digit code the app shows.',
    'auth.enrol.secretLabel': 'Or enter this key in the app by hand:',
    'auth.enrol.codeLabel': 'Code from the app',
    'auth.enrol.confirm': 'Confirm',
    'auth.enrol.passkeyOr':
      'Or set up a passkey instead, with this device or a security key:',

    'auth.passkey.name': 'Name of this passkey',
    'auth.passkey.namePlaceholder': 'Passkey',
    'auth.passkey.add': 'Set up a passkey',
    'auth.passkey.promptSignIn': 'Sign in with a passkey',
    'auth.passkey.promptCreate': 'Create a passkey',
    'auth.passkey.promptHint': 'Use your fingerprint, face or screen lock',
    'auth.passkey.promptDone': 'Confirmed',

    'auth.codes.title': 'Recovery codes',
    'auth.codes.intro':
      'Save these codes somewhere safe. Each one signs you in once if you lose your authenticator or passkey.',
    'auth.codes.once': 'They are shown only once.',
    'auth.codes.download': 'Download (.txt)',
    'auth.codes.saved': 'I have saved my recovery codes',
    'auth.codes.continue': 'Continue',

    'auth.sso.pickTitle': 'Pick an account',
    'auth.sso.pickSubtitle': 'to continue to “{app}”',
    'auth.sso.appName': '{company} phone system',
    'auth.sso.demoNote':
      'Demo: simulates the identity provider’s sign-in page. With SSO the second step is skipped – the provider’s own two-factor sign-in applies.',

    'auth.demo.title': 'Demo accounts',
    'auth.demo.stepTitle': 'Demo helpers',
    'auth.demo.intro': 'Sign in with one click – any password works.',
    'auth.demo.method.totp': 'Authenticator',
    'auth.demo.method.passkeys': '{count}× passkey',
    'auth.demo.method.none': 'no second factor',
    'auth.demo.tryEnrol': 'See the first-time two-factor setup (as {name})',
    'auth.demo.pages': 'More pages',
    'auth.demo.consentPage': 'Consent (MCP)',
    'auth.demo.authenticator': 'Authenticator app on the phone',
    'auth.demo.useCode': 'Use code',
    'auth.demo.secondsLeft': 'Valid for {seconds} more seconds',
    'auth.demo.anyCode':
      'Demo: any 6-digit code is accepted; passkeys are simulated.',
    'auth.demo.codesNote':
      'Demo: the codes are random. Tick “saved” to continue.',
    'auth.demo.backToPersonas': 'Back to the demo accounts',

    'auth.toast.welcome': 'Welcome, {name}',
    'auth.toast.mailed': 'Notification e-mailed to {email}.',
    'auth.toast.totpAdded': 'Authenticator app set up',
    'auth.toast.totpReplaced': 'Authenticator app replaced',
    'auth.toast.totpRemoved': 'Authenticator app removed',
    'auth.toast.passkeyAdded': 'Passkey “{name}” set up',
    'auth.toast.passkeyRemoved': 'Passkey “{name}” removed',

    'auth.forgot.title': 'Forgot password',
    'auth.forgot.intro':
      'Enter your e-mail and we will send you a link to set a new password.',
    'auth.forgot.submit': 'Send reset link',
    'auth.forgot.sent':
      'If that address has an account, a reset link is on its way.',
    'auth.forgot.validity': 'The link is valid for one hour.',

    'auth.setPassword.title': 'Set your password',
    'auth.setPassword.password': 'New password',
    'auth.setPassword.show': 'Show password',
    'auth.setPassword.hide': 'Hide password',
    'auth.setPassword.rule': 'At least {min} characters',
    'auth.setPassword.note':
      'Setting a new password signs you out on every device.',
    'auth.setPassword.submit': 'Set password',
    'auth.setPassword.success': 'Your password has been set.',
    'auth.setPassword.toLogin': 'Continue to sign in',
    'auth.setPassword.invalid': 'This link has expired or was already used.',
    'auth.setPassword.requestNew': 'Request a new link',
    'auth.setPassword.tooShort':
      'The password must be at least {min} characters.',

    'auth.consent.pageTitle': 'Allow access',
    'auth.consent.title': '{client} wants to access {company}',
    'auth.consent.actsAs': 'acting as',
    'auth.consent.canTitle': 'What {client} can then do',
    'auth.consent.can.owner':
      'Everything you may do in the phone system as an owner: read and change users, numbers, forwarding and every setting.',
    'auth.consent.can.admin':
      'Everything you may do in the phone system as an admin: read and change users, ring groups, numbers, forwarding and settings.',
    'auth.consent.can.user':
      'Everything you may do yourself in the phone system: read your calls and voicemail, change your forwarding and out-of-office.',
    'auth.consent.can.role':
      'Your current role always applies: if it changes, so does what {client} may do.',
    'auth.consent.can.audit':
      'Every change is recorded in the audit log, attributed to {client}.',
    'auth.consent.redirect': 'Afterwards you return to',
    'auth.consent.approve': 'Approve',
    'auth.consent.deny': 'Deny',
    'auth.consent.approved': '{client} is connected',
    'auth.consent.denied': 'Access for {client} denied',

    'auth.error.title': 'Sign-in problem',
    'auth.error.expired': 'This link has expired. Please try again.',
    'auth.error.noUser': 'No account matches that sign-in.',
    'auth.error.noPassword':
      'Set your password first, through the link you were sent, then sign in.',
    'auth.error.domain': 'Your e-mail domain is not allowed to sign in here.',
    'auth.error.unverifiedEmail':
      'Your identity provider has not verified this e-mail address.',
    'auth.error.issuer':
      'This sign-in was issued by the wrong identity provider.',
    'auth.error.audience':
      'This sign-in was issued for a different application.',
    'auth.error.signature': 'This sign-in could not be verified.',
    'auth.error.nonce': 'This sign-in could not be verified.',
    'auth.error.generic': 'Something went wrong while signing in.',

    'auth.done.title': 'You are signed in',
    'auth.done.message': 'You have signed in to {company}.',
    'auth.done.mcpHint': 'Connect an MCP client with:',
    'auth.done.toApp': 'Open the phone system',
    'auth.done.security': 'Manage two-factor sign-in',

    'security.gate.title': 'Two-factor sign-in',
    'security.gate.intro':
      'Sign in again to manage how you confirm your sign-ins. This page then stays open for 10 minutes.',
    'security.gate.demoHint': 'Demo: any password works.',
    'security.session.signedInAs':
      'Signed in as {email} for the next 10 minutes.',
    'security.session.left': '{time} minutes left',
    'security.session.lock': 'Lock',
    'security.required': 'Your account must keep at least one second factor.',
    'security.requiredWhy.owner': 'This applies to every owner.',
    'security.requiredWhy.admin': 'This applies to every admin.',
    'security.requiredWhy.all': 'In this company it applies to everyone.',
    'security.lastMethodHint':
      'Your last second factor: set up another one before removing this one.',
    'security.lastUsed': 'last used {date}',
    'security.neverUsed': 'never used',
    'security.passkeys.title': 'Passkeys',
    'security.passkeys.description':
      'Sign in with your fingerprint, face or a security key – no code to type.',
    'security.passkeys.empty': 'No passkeys yet.',
    'security.passkeys.added': 'set up {date}',
    'security.totp.title': 'Authenticator app',
    'security.totp.description':
      'A 6-digit code that changes every 30 seconds.',
    'security.totp.on': 'Set up',
    'security.totp.off': 'Not set up',
    'security.totp.start': 'Set up an authenticator app',
    'security.totp.replace': 'Replace the authenticator app',
    'security.totp.remove': 'Remove the authenticator app',
    'security.totp.setupIntro':
      'Scan the QR code with an authenticator app, then enter the code it shows.',
    'security.totp.replaceIntro':
      'The current app stops working as soon as you confirm the new one’s first code.',
    'security.codes.title': 'Recovery codes',
    'security.codes.description':
      'For emergencies, when neither phone nor passkey is at hand. Each code works once.',
    'security.codes.left': '{count} unused',
    'security.codes.regenerate': 'Generate new recovery codes',
    'security.codes.regenerateNote': 'Your previous codes stop working.',
    'security.codes.regenerated': 'New recovery codes generated',
    'security.codes.done': 'Done',
    'security.codes.hide': 'Hide codes',

    'errors.auth.invalidCode': 'Incorrect code.',
    'errors.auth.passkeyFailed': 'The passkey could not be verified.',
    'errors.auth.lastMethod':
      'Your account must keep a second factor: set up another one before removing this one.',
    'errors.auth.codesNeedMethod':
      'Set up an authenticator app or a passkey first.'
  }
} satisfies Messages;
