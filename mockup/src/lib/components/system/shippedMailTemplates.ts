/**
 * The shipped mail templates (`packages/api/src/lib/server/mail/builtin/<kind>.<language>.json`),
 * copied verbatim: what applies wherever the tenant has no override, and what *Revert* returns to.
 * Generated from the API source. The mockup words the two update mails for customers: they
 * point to the System & Updates page and to whoever runs the server, not to internal operations
 * or host scripts.
 */
import type { Language, MailKind } from '#lib/api/types.js';

export type TemplateSource = {
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
};

export const SHIPPED_TEMPLATES: Record<
  MailKind,
  Record<Language, TemplateSource>
> = {
  voicemail: {
    de: {
      subject:
        'Neue Sprachnachricht von {{#if callerName}}{{callerName}}{{else if callerNumber}}{{callerNumber}}{{else}}einer unterdrückten Nummer{{/if}}',
      bodyText:
        'Hallo {{recipientName}},\n\nSie haben eine neue Sprachnachricht in {{mailboxName}} von {{#if callerName}}{{callerName}} ({{callerNumber}}){{else if callerNumber}}{{callerNumber}}{{else}}einer unterdrückten Nummer{{/if}}, empfangen am {{date receivedAt}}. Länge: {{durationS}} Sek.\n\nDie Aufnahme ist dieser E-Mail angehängt.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Hallo {{recipientName}},</p><p>Sie haben eine neue Sprachnachricht in {{mailboxName}} von {{#if callerName}}{{callerName}} ({{callerNumber}}){{else if callerNumber}}{{callerNumber}}{{else}}einer unterdrückten Nummer{{/if}}, empfangen am {{date receivedAt}}. Länge: {{durationS}} Sek.</p><p>Die Aufnahme ist dieser E-Mail angehängt.</p><p>{{companyName}} · {{fqdn}}</p>'
    },
    en: {
      subject:
        'New voicemail from {{#if callerName}}{{callerName}}{{else if callerNumber}}{{callerNumber}}{{else}}a withheld number{{/if}}',
      bodyText:
        'Hi {{recipientName}},\n\nYou have a new voicemail in {{mailboxName}} from {{#if callerName}}{{callerName}} ({{callerNumber}}){{else if callerNumber}}{{callerNumber}}{{else}}a withheld number{{/if}}, received {{date receivedAt}}. Length: {{durationS}} s.\n\nThe recording is attached to this e-mail.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Hi {{recipientName}},</p><p>You have a new voicemail in {{mailboxName}} from {{#if callerName}}{{callerName}} ({{callerNumber}}){{else if callerNumber}}{{callerNumber}}{{else}}a withheld number{{/if}}, received {{date receivedAt}}. Length: {{durationS}} s.</p><p>The recording is attached to this e-mail.</p><p>{{companyName}} · {{fqdn}}</p>'
    },
    es: {
      subject:
        'Nuevo mensaje de voz de {{#if callerName}}{{callerName}}{{else if callerNumber}}{{callerNumber}}{{else}}un número oculto{{/if}}',
      bodyText:
        'Hola {{recipientName}},\n\nTiene un nuevo mensaje de voz en {{mailboxName}} de {{#if callerName}}{{callerName}} ({{callerNumber}}){{else if callerNumber}}{{callerNumber}}{{else}}un número oculto{{/if}}, recibido el {{date receivedAt}}. Duración: {{durationS}} s.\n\nLa grabación está adjunta a este correo.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Hola {{recipientName}},</p><p>Tiene un nuevo mensaje de voz en {{mailboxName}} de {{#if callerName}}{{callerName}} ({{callerNumber}}){{else if callerNumber}}{{callerNumber}}{{else}}un número oculto{{/if}}, recibido el {{date receivedAt}}. Duración: {{durationS}} s.</p><p>La grabación está adjunta a este correo.</p><p>{{companyName}} · {{fqdn}}</p>'
    },
    fr: {
      subject:
        "Nouveau message vocal {{#if callerName}}de {{callerName}}{{else if callerNumber}}de {{callerNumber}}{{else}}d'un numéro masqué{{/if}}",
      bodyText:
        "Bonjour {{recipientName}},\n\nVous avez un nouveau message vocal dans {{mailboxName}} {{#if callerName}}de {{callerName}} ({{callerNumber}}){{else if callerNumber}}de {{callerNumber}}{{else}}d'un numéro masqué{{/if}}, reçu le {{date receivedAt}}. Durée : {{durationS}} s.\n\nL'enregistrement est joint à cet e-mail.\n\n{{companyName}} · {{fqdn}}",
      bodyHtml:
        "<p>Bonjour {{recipientName}},</p><p>Vous avez un nouveau message vocal dans {{mailboxName}} {{#if callerName}}de {{callerName}} ({{callerNumber}}){{else if callerNumber}}de {{callerNumber}}{{else}}d'un numéro masqué{{/if}}, reçu le {{date receivedAt}}. Durée : {{durationS}} s.</p><p>L'enregistrement est joint à cet e-mail.</p><p>{{companyName}} · {{fqdn}}</p>"
    },
    it: {
      subject:
        'Nuovo messaggio vocale da {{#if callerName}}{{callerName}}{{else if callerNumber}}{{callerNumber}}{{else}}un numero privato{{/if}}',
      bodyText:
        'Ciao {{recipientName}},\n\nHai un nuovo messaggio vocale in {{mailboxName}} da {{#if callerName}}{{callerName}} ({{callerNumber}}){{else if callerNumber}}{{callerNumber}}{{else}}un numero privato{{/if}}, ricevuto il {{date receivedAt}}. Durata: {{durationS}} s.\n\nLa registrazione è allegata a questa e-mail.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Ciao {{recipientName}},</p><p>Hai un nuovo messaggio vocale in {{mailboxName}} da {{#if callerName}}{{callerName}} ({{callerNumber}}){{else if callerNumber}}{{callerNumber}}{{else}}un numero privato{{/if}}, ricevuto il {{date receivedAt}}. Durata: {{durationS}} s.</p><p>La registrazione è allegata a questa e-mail.</p><p>{{companyName}} · {{fqdn}}</p>'
    },
    ru: {
      subject:
        'Новое голосовое сообщение от {{#if callerName}}{{callerName}}{{else if callerNumber}}{{callerNumber}}{{else}}скрытого номера{{/if}}',
      bodyText:
        'Здравствуйте, {{recipientName}}!\n\nВам поступило новое голосовое сообщение в {{mailboxName}} от {{#if callerName}}{{callerName}} ({{callerNumber}}){{else if callerNumber}}{{callerNumber}}{{else}}скрытого номера{{/if}}, получено {{date receivedAt}}. Длительность: {{durationS}} сек.\n\nЗапись прикреплена к этому письму.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Здравствуйте, {{recipientName}}!</p><p>Вам поступило новое голосовое сообщение в {{mailboxName}} от {{#if callerName}}{{callerName}} ({{callerNumber}}){{else if callerNumber}}{{callerNumber}}{{else}}скрытого номера{{/if}}, получено {{date receivedAt}}. Длительность: {{durationS}} сек.</p><p>Запись прикреплена к этому письму.</p><p>{{companyName}} · {{fqdn}}</p>'
    }
  },
  missedCall: {
    de: {
      subject: 'Verpasster Anruf auf {{didLabel}}',
      bodyText:
        'Hallo {{recipientName}},\n\nSie haben einen Anruf auf {{didLabel}} verpasst, von {{#if callerName}}{{callerName}} ({{callerNumber}}){{else if callerNumber}}{{callerNumber}}{{else}}einer unterdrückten Nummer{{/if}} um {{date receivedAt}}.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Hallo {{recipientName}},</p><p>Sie haben einen Anruf auf {{didLabel}} verpasst, von {{#if callerName}}{{callerName}} ({{callerNumber}}){{else if callerNumber}}{{callerNumber}}{{else}}einer unterdrückten Nummer{{/if}} um {{date receivedAt}}.</p><p>{{companyName}} · {{fqdn}}</p>'
    },
    en: {
      subject: 'Missed call on {{didLabel}}',
      bodyText:
        'Hi {{recipientName}},\n\nYou missed a call on {{didLabel}} from {{#if callerName}}{{callerName}} ({{callerNumber}}){{else if callerNumber}}{{callerNumber}}{{else}}a withheld number{{/if}} at {{date receivedAt}}.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Hi {{recipientName}},</p><p>You missed a call on {{didLabel}} from {{#if callerName}}{{callerName}} ({{callerNumber}}){{else if callerNumber}}{{callerNumber}}{{else}}a withheld number{{/if}} at {{date receivedAt}}.</p><p>{{companyName}} · {{fqdn}}</p>'
    },
    es: {
      subject: 'Llamada perdida en {{didLabel}}',
      bodyText:
        'Hola {{recipientName}},\n\nHa perdido una llamada en {{didLabel}} de {{#if callerName}}{{callerName}} ({{callerNumber}}){{else if callerNumber}}{{callerNumber}}{{else}}un número oculto{{/if}} a las {{date receivedAt}}.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Hola {{recipientName}},</p><p>Ha perdido una llamada en {{didLabel}} de {{#if callerName}}{{callerName}} ({{callerNumber}}){{else if callerNumber}}{{callerNumber}}{{else}}un número oculto{{/if}} a las {{date receivedAt}}.</p><p>{{companyName}} · {{fqdn}}</p>'
    },
    fr: {
      subject: 'Appel manqué sur {{didLabel}}',
      bodyText:
        "Bonjour {{recipientName}},\n\nVous avez manqué un appel sur {{didLabel}} {{#if callerName}}de {{callerName}} ({{callerNumber}}){{else if callerNumber}}de {{callerNumber}}{{else}}d'un numéro masqué{{/if}} à {{date receivedAt}}.\n\n{{companyName}} · {{fqdn}}",
      bodyHtml:
        "<p>Bonjour {{recipientName}},</p><p>Vous avez manqué un appel sur {{didLabel}} {{#if callerName}}de {{callerName}} ({{callerNumber}}){{else if callerNumber}}de {{callerNumber}}{{else}}d'un numéro masqué{{/if}} à {{date receivedAt}}.</p><p>{{companyName}} · {{fqdn}}</p>"
    },
    it: {
      subject: 'Chiamata persa su {{didLabel}}',
      bodyText:
        'Ciao {{recipientName}},\n\nHai perso una chiamata su {{didLabel}} da {{#if callerName}}{{callerName}} ({{callerNumber}}){{else if callerNumber}}{{callerNumber}}{{else}}un numero privato{{/if}} alle {{date receivedAt}}.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Ciao {{recipientName}},</p><p>Hai perso una chiamata su {{didLabel}} da {{#if callerName}}{{callerName}} ({{callerNumber}}){{else if callerNumber}}{{callerNumber}}{{else}}un numero privato{{/if}} alle {{date receivedAt}}.</p><p>{{companyName}} · {{fqdn}}</p>'
    },
    ru: {
      subject: 'Пропущенный звонок на {{didLabel}}',
      bodyText:
        'Здравствуйте, {{recipientName}}!\n\nВы пропустили звонок на {{didLabel}} от {{#if callerName}}{{callerName}} ({{callerNumber}}){{else if callerNumber}}{{callerNumber}}{{else}}скрытого номера{{/if}} в {{date receivedAt}}.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Здравствуйте, {{recipientName}}!</p><p>Вы пропустили звонок на {{didLabel}} от {{#if callerName}}{{callerName}} ({{callerNumber}}){{else if callerNumber}}{{callerNumber}}{{else}}скрытого номера{{/if}} в {{date receivedAt}}.</p><p>{{companyName}} · {{fqdn}}</p>'
    }
  },
  setup: {
    de: {
      subject: 'Passwort für {{companyName}} festlegen',
      bodyText:
        'Hallo {{recipientName}},\n\n{{#if invitedBy}}{{invitedBy}} hat Ihr {{companyName}}-Telefonanlagenkonto erstellt.{{else}}Ihre {{companyName}}-Telefonanlage ist bereit.{{/if}} Legen Sie Ihr Passwort über diesen Link fest:\n\n{{link}}\n\nDieser Link läuft am {{date linkExpiresAt}} ab.\n{{#unless invitedBy}}\nSobald Sie angemeldet sind, verbinden Sie Ihren KI-Assistenten über MCP mit {{fqdn}}, um die Telefonanlage per Chat zu verwalten.\n{{/unless}}\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Hallo {{recipientName}},</p><p>{{#if invitedBy}}{{invitedBy}} hat Ihr {{companyName}}-Telefonanlagenkonto erstellt.{{else}}Ihre {{companyName}}-Telefonanlage ist bereit.{{/if}} Legen Sie Ihr Passwort über diesen Link fest:</p><p><a href="{{link}}">{{link}}</a></p><p>Dieser Link läuft am {{date linkExpiresAt}} ab.</p>{{#unless invitedBy}}<p>Sobald Sie angemeldet sind, verbinden Sie Ihren KI-Assistenten über MCP mit {{fqdn}}, um die Telefonanlage per Chat zu verwalten.</p>{{/unless}}<p>{{companyName}} · {{fqdn}}</p>'
    },
    en: {
      subject: 'Set your {{companyName}} password',
      bodyText:
        'Hi {{recipientName}},\n\n{{#if invitedBy}}{{invitedBy}} created your {{companyName}} phone system account.{{else}}Your {{companyName}} phone system is ready.{{/if}} Set your password using the link below:\n\n{{link}}\n\nThis link expires {{date linkExpiresAt}}.\n{{#unless invitedBy}}\nOnce you are signed in, connect your AI assistant to {{fqdn}} over MCP to manage the phone system by chat.\n{{/unless}}\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Hi {{recipientName}},</p><p>{{#if invitedBy}}{{invitedBy}} created your {{companyName}} phone system account.{{else}}Your {{companyName}} phone system is ready.{{/if}} Set your password using the link below:</p><p><a href="{{link}}">{{link}}</a></p><p>This link expires {{date linkExpiresAt}}.</p>{{#unless invitedBy}}<p>Once you are signed in, connect your AI assistant to {{fqdn}} over MCP to manage the phone system by chat.</p>{{/unless}}<p>{{companyName}} · {{fqdn}}</p>'
    },
    es: {
      subject: 'Configure su contraseña de {{companyName}}',
      bodyText:
        'Hola {{recipientName}},\n\n{{#if invitedBy}}{{invitedBy}} creó su cuenta de la centralita {{companyName}}.{{else}}Su centralita {{companyName}} está lista.{{/if}} Configure su contraseña con este enlace:\n\n{{link}}\n\nEste enlace caduca el {{date linkExpiresAt}}.\n{{#unless invitedBy}}\nUna vez que haya iniciado sesión, conecte su asistente de IA a {{fqdn}} mediante MCP para gestionar la centralita por chat.\n{{/unless}}\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Hola {{recipientName}},</p><p>{{#if invitedBy}}{{invitedBy}} creó su cuenta de la centralita {{companyName}}.{{else}}Su centralita {{companyName}} está lista.{{/if}} Configure su contraseña con este enlace:</p><p><a href="{{link}}">{{link}}</a></p><p>Este enlace caduca el {{date linkExpiresAt}}.</p>{{#unless invitedBy}}<p>Una vez que haya iniciado sesión, conecte su asistente de IA a {{fqdn}} mediante MCP para gestionar la centralita por chat.</p>{{/unless}}<p>{{companyName}} · {{fqdn}}</p>'
    },
    fr: {
      subject: 'Définissez votre mot de passe {{companyName}}',
      bodyText:
        'Bonjour {{recipientName}},\n\n{{#if invitedBy}}{{invitedBy}} a créé votre compte du standard {{companyName}}.{{else}}Votre standard {{companyName}} est prêt.{{/if}} Définissez votre mot de passe via ce lien :\n\n{{link}}\n\nCe lien expire le {{date linkExpiresAt}}.\n{{#unless invitedBy}}\nUne fois connecté, connectez votre assistant IA à {{fqdn}} via MCP pour gérer le standard par chat.\n{{/unless}}\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Bonjour {{recipientName}},</p><p>{{#if invitedBy}}{{invitedBy}} a créé votre compte du standard {{companyName}}.{{else}}Votre standard {{companyName}} est prêt.{{/if}} Définissez votre mot de passe via ce lien :</p><p><a href="{{link}}">{{link}}</a></p><p>Ce lien expire le {{date linkExpiresAt}}.</p>{{#unless invitedBy}}<p>Une fois connecté, connectez votre assistant IA à {{fqdn}} via MCP pour gérer le standard par chat.</p>{{/unless}}<p>{{companyName}} · {{fqdn}}</p>'
    },
    it: {
      subject: 'Imposta la tua password {{companyName}}',
      bodyText:
        "Ciao {{recipientName}},\n\n{{#if invitedBy}}{{invitedBy}} ha creato il tuo account del centralino {{companyName}}.{{else}}Il tuo centralino {{companyName}} è pronto.{{/if}} Imposta la tua password con questo link:\n\n{{link}}\n\nQuesto link scade il {{date linkExpiresAt}}.\n{{#unless invitedBy}}\nUna volta effettuato l'accesso, collega il tuo assistente IA a {{fqdn}} tramite MCP per gestire il centralino via chat.\n{{/unless}}\n{{companyName}} · {{fqdn}}",
      bodyHtml:
        '<p>Ciao {{recipientName}},</p><p>{{#if invitedBy}}{{invitedBy}} ha creato il tuo account del centralino {{companyName}}.{{else}}Il tuo centralino {{companyName}} è pronto.{{/if}} Imposta la tua password con questo link:</p><p><a href="{{link}}">{{link}}</a></p><p>Questo link scade il {{date linkExpiresAt}}.</p>{{#unless invitedBy}}<p>Una volta effettuato l\'accesso, collega il tuo assistente IA a {{fqdn}} tramite MCP per gestire il centralino via chat.</p>{{/unless}}<p>{{companyName}} · {{fqdn}}</p>'
    },
    ru: {
      subject: 'Задайте пароль для {{companyName}}',
      bodyText:
        'Здравствуйте, {{recipientName}}!\n\n{{#if invitedBy}}{{invitedBy}} создал(а) вашу учётную запись АТС {{companyName}}.{{else}}Ваша АТС {{companyName}} готова к работе.{{/if}} Задайте пароль по ссылке:\n\n{{link}}\n\nСрок действия ссылки истекает {{date linkExpiresAt}}.\n{{#unless invitedBy}}\nПосле входа подключите своего ИИ-ассистента к {{fqdn}} по MCP, чтобы управлять АТС через чат.\n{{/unless}}\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Здравствуйте, {{recipientName}}!</p><p>{{#if invitedBy}}{{invitedBy}} создал(а) вашу учётную запись АТС {{companyName}}.{{else}}Ваша АТС {{companyName}} готова к работе.{{/if}} Задайте пароль по ссылке:</p><p><a href="{{link}}">{{link}}</a></p><p>Срок действия ссылки истекает {{date linkExpiresAt}}.</p>{{#unless invitedBy}}<p>После входа подключите своего ИИ-ассистента к {{fqdn}} по MCP, чтобы управлять АТС через чат.</p>{{/unless}}<p>{{companyName}} · {{fqdn}}</p>'
    }
  },
  reset: {
    de: {
      subject: 'Passwort für {{companyName}} zurücksetzen',
      bodyText:
        'Hallo {{recipientName}},\n\nSetzen Sie Ihr Passwort über diesen Link zurück:\n\n{{link}}\n\nDieser Link läuft am {{date linkExpiresAt}} ab. Falls Sie dies nicht angefordert haben, können Sie diese E-Mail ignorieren.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Hallo {{recipientName}},</p><p>Setzen Sie Ihr Passwort über diesen Link zurück:</p><p><a href="{{link}}">{{link}}</a></p><p>Dieser Link läuft am {{date linkExpiresAt}} ab. Falls Sie dies nicht angefordert haben, können Sie diese E-Mail ignorieren.</p><p>{{companyName}} · {{fqdn}}</p>'
    },
    en: {
      subject: 'Reset your {{companyName}} password',
      bodyText:
        'Hi {{recipientName}},\n\nReset your password using the link below:\n\n{{link}}\n\nThis link expires {{date linkExpiresAt}}. If you did not request this, you can ignore this e-mail.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Hi {{recipientName}},</p><p>Reset your password using the link below:</p><p><a href="{{link}}">{{link}}</a></p><p>This link expires {{date linkExpiresAt}}. If you did not request this, you can ignore this e-mail.</p><p>{{companyName}} · {{fqdn}}</p>'
    },
    es: {
      subject: 'Restablezca su contraseña de {{companyName}}',
      bodyText:
        'Hola {{recipientName}},\n\nRestablezca su contraseña con este enlace:\n\n{{link}}\n\nEste enlace caduca el {{date linkExpiresAt}}. Si no solicitó esto, puede ignorar este correo.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Hola {{recipientName}},</p><p>Restablezca su contraseña con este enlace:</p><p><a href="{{link}}">{{link}}</a></p><p>Este enlace caduca el {{date linkExpiresAt}}. Si no solicitó esto, puede ignorar este correo.</p><p>{{companyName}} · {{fqdn}}</p>'
    },
    fr: {
      subject: 'Réinitialisez votre mot de passe {{companyName}}',
      bodyText:
        "Bonjour {{recipientName}},\n\nRéinitialisez votre mot de passe via ce lien :\n\n{{link}}\n\nCe lien expire le {{date linkExpiresAt}}. Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet e-mail.\n\n{{companyName}} · {{fqdn}}",
      bodyHtml:
        '<p>Bonjour {{recipientName}},</p><p>Réinitialisez votre mot de passe via ce lien :</p><p><a href="{{link}}">{{link}}</a></p><p>Ce lien expire le {{date linkExpiresAt}}. Si vous n\'êtes pas à l\'origine de cette demande, vous pouvez ignorer cet e-mail.</p><p>{{companyName}} · {{fqdn}}</p>'
    },
    it: {
      subject: 'Reimposta la tua password {{companyName}}',
      bodyText:
        'Ciao {{recipientName}},\n\nReimposta la tua password con questo link:\n\n{{link}}\n\nQuesto link scade il {{date linkExpiresAt}}. Se non hai richiesto questo, puoi ignorare questa e-mail.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Ciao {{recipientName}},</p><p>Reimposta la tua password con questo link:</p><p><a href="{{link}}">{{link}}</a></p><p>Questo link scade il {{date linkExpiresAt}}. Se non hai richiesto questo, puoi ignorare questa e-mail.</p><p>{{companyName}} · {{fqdn}}</p>'
    },
    ru: {
      subject: 'Сброс пароля для {{companyName}}',
      bodyText:
        'Здравствуйте, {{recipientName}}!\n\nСбросьте пароль по ссылке:\n\n{{link}}\n\nСрок действия ссылки истекает {{date linkExpiresAt}}. Если вы не запрашивали это, просто проигнорируйте это письмо.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Здравствуйте, {{recipientName}}!</p><p>Сбросьте пароль по ссылке:</p><p><a href="{{link}}">{{link}}</a></p><p>Срок действия ссылки истекает {{date linkExpiresAt}}. Если вы не запрашивали это, просто проигнорируйте это письмо.</p><p>{{companyName}} · {{fqdn}}</p>'
    }
  },
  updateFailed: {
    de: {
      subject: 'Automatisches Update auf {{toVersion}} fehlgeschlagen',
      bodyText:
        'Hallo {{recipientName}},\n\nDas automatische Update von {{fqdn}}{{#if fromVersion}} von {{fromVersion}}{{/if}} auf {{toVersion}} ist am {{date failedAt}} fehlgeschlagen:\n\n{{reason}}\n\nZamfono versucht dieses Release nicht noch einmal von selbst. Die Einzelheiten finden Sie in Zamfono unter „System & Updates“. Sobald die Ursache behoben ist, starten Sie das Update dort mit „Jetzt aktualisieren“ – oder bitten Sie die Betreuung Ihres Servers, es einzuspielen.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Hallo {{recipientName}},</p><p>Das automatische Update von {{fqdn}}{{#if fromVersion}} von {{fromVersion}}{{/if}} auf {{toVersion}} ist am {{date failedAt}} fehlgeschlagen:</p><p>{{reason}}</p><p>Zamfono versucht dieses Release nicht noch einmal von selbst. Die Einzelheiten finden Sie in Zamfono unter „System & Updates“. Sobald die Ursache behoben ist, starten Sie das Update dort mit „Jetzt aktualisieren“ – oder bitten Sie die Betreuung Ihres Servers, es einzuspielen.</p><p>{{companyName}} · {{fqdn}}</p>'
    },
    en: {
      subject: 'Automatic update to {{toVersion}} failed',
      bodyText:
        'Hi {{recipientName}},\n\nThe automatic update of {{fqdn}}{{#if fromVersion}} from {{fromVersion}}{{/if}} to {{toVersion}} failed at {{date failedAt}}:\n\n{{reason}}\n\nZamfono does not try this release again on its own. You find the details in Zamfono under “System & updates”. Once the cause is fixed, start the update there with “Update now”, or ask whoever runs your server to install it.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Hi {{recipientName}},</p><p>The automatic update of {{fqdn}}{{#if fromVersion}} from {{fromVersion}}{{/if}} to {{toVersion}} failed at {{date failedAt}}:</p><p>{{reason}}</p><p>Zamfono does not try this release again on its own. You find the details in Zamfono under “System & updates”. Once the cause is fixed, start the update there with “Update now”, or ask whoever runs your server to install it.</p><p>{{companyName}} · {{fqdn}}</p>'
    },
    es: {
      subject: 'La actualización automática a {{toVersion}} ha fallado',
      bodyText:
        'Hola {{recipientName}},\n\nLa actualización automática de {{fqdn}}{{#if fromVersion}} de {{fromVersion}}{{/if}} a {{toVersion}} ha fallado el {{date failedAt}}:\n\n{{reason}}\n\nZamfono no vuelve a intentar esta versión por sí solo. Encontrará los detalles en Zamfono, en «Sistema y actualizaciones». Una vez resuelta la causa, inicie allí la actualización con «Actualizar ahora» o pida a quien gestiona su servidor que la instale.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Hola {{recipientName}},</p><p>La actualización automática de {{fqdn}}{{#if fromVersion}} de {{fromVersion}}{{/if}} a {{toVersion}} ha fallado el {{date failedAt}}:</p><p>{{reason}}</p><p>Zamfono no vuelve a intentar esta versión por sí solo. Encontrará los detalles en Zamfono, en «Sistema y actualizaciones». Una vez resuelta la causa, inicie allí la actualización con «Actualizar ahora» o pida a quien gestiona su servidor que la instale.</p><p>{{companyName}} · {{fqdn}}</p>'
    },
    fr: {
      subject: 'Échec de la mise à jour automatique vers {{toVersion}}',
      bodyText:
        "Bonjour {{recipientName}},\n\nLa mise à jour automatique de {{fqdn}}{{#if fromVersion}} de {{fromVersion}}{{/if}} vers {{toVersion}} a échoué le {{date failedAt}} :\n\n{{reason}}\n\nZamfono ne retente pas cette version de lui-même. Vous trouverez le détail dans Zamfono, sous « Système et mises à jour ». Une fois la cause corrigée, lancez-y la mise à jour avec « Mettre à jour maintenant », ou demandez à la personne qui gère votre serveur de l'installer.\n\n{{companyName}} · {{fqdn}}",
      bodyHtml:
        "<p>Bonjour {{recipientName}},</p><p>La mise à jour automatique de {{fqdn}}{{#if fromVersion}} de {{fromVersion}}{{/if}} vers {{toVersion}} a échoué le {{date failedAt}} :</p><p>{{reason}}</p><p>Zamfono ne retente pas cette version de lui-même. Vous trouverez le détail dans Zamfono, sous « Système et mises à jour ». Une fois la cause corrigée, lancez-y la mise à jour avec « Mettre à jour maintenant », ou demandez à la personne qui gère votre serveur de l'installer.</p><p>{{companyName}} · {{fqdn}}</p>"
    },
    it: {
      subject: 'Aggiornamento automatico a {{toVersion}} non riuscito',
      bodyText:
        "Ciao {{recipientName}},\n\nL'aggiornamento automatico di {{fqdn}}{{#if fromVersion}} da {{fromVersion}}{{/if}} a {{toVersion}} non è riuscito il {{date failedAt}}:\n\n{{reason}}\n\nZamfono non ritenta questa release da solo. Trovi i dettagli in Zamfono, alla voce «Sistema e aggiornamenti». Risolta la causa, avvia lì l'aggiornamento con «Aggiorna ora», oppure chiedi a chi gestisce il tuo server di installarlo.\n\n{{companyName}} · {{fqdn}}",
      bodyHtml:
        "<p>Ciao {{recipientName}},</p><p>L'aggiornamento automatico di {{fqdn}}{{#if fromVersion}} da {{fromVersion}}{{/if}} a {{toVersion}} non è riuscito il {{date failedAt}}:</p><p>{{reason}}</p><p>Zamfono non ritenta questa release da solo. Trovi i dettagli in Zamfono, alla voce «Sistema e aggiornamenti». Risolta la causa, avvia lì l'aggiornamento con «Aggiorna ora», oppure chiedi a chi gestisce il tuo server di installarlo.</p><p>{{companyName}} · {{fqdn}}</p>"
    },
    ru: {
      subject: 'Автоматическое обновление до {{toVersion}} не удалось',
      bodyText:
        'Здравствуйте, {{recipientName}}!\n\nАвтоматическое обновление {{fqdn}}{{#if fromVersion}} с {{fromVersion}}{{/if}} до {{toVersion}} не удалось {{date failedAt}}:\n\n{{reason}}\n\nZamfono не повторяет этот релиз сам. Подробности — в Zamfono, в разделе «Система и обновления». Устранив причину, запустите там обновление кнопкой «Обновить сейчас» или попросите того, кто обслуживает ваш сервер, установить его.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Здравствуйте, {{recipientName}}!</p><p>Автоматическое обновление {{fqdn}}{{#if fromVersion}} с {{fromVersion}}{{/if}} до {{toVersion}} не удалось {{date failedAt}}:</p><p>{{reason}}</p><p>Zamfono не повторяет этот релиз сам. Подробности — в Zamfono, в разделе «Система и обновления». Устранив причину, запустите там обновление кнопкой «Обновить сейчас» или попросите того, кто обслуживает ваш сервер, установить его.</p><p>{{companyName}} · {{fqdn}}</p>'
    }
  },
  breakingUpdate: {
    de: {
      subject: 'Zamfono {{version}} braucht ein manuelles Update',
      bodyText:
        'Hallo {{recipientName}},\n\nZamfono {{version}} ist erschienen{{#if publishedAt}}, am {{date publishedAt}}{{/if}}. Es ist ein Release mit inkompatiblen Änderungen, daher installiert {{fqdn}} auf {{currentVersion}} es nicht von selbst.\n\nLesen Sie die Release Notes{{#if releaseUrl}} ({{releaseUrl}}){{/if}} und bitten Sie dann die Betreuung Ihres Servers, das Update einzuspielen.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Hallo {{recipientName}},</p><p>Zamfono {{version}} ist erschienen{{#if publishedAt}}, am {{date publishedAt}}{{/if}}. Es ist ein Release mit inkompatiblen Änderungen, daher installiert {{fqdn}} auf {{currentVersion}} es nicht von selbst.</p><p>Lesen Sie die Release Notes{{#if releaseUrl}} ({{releaseUrl}}){{/if}} und bitten Sie dann die Betreuung Ihres Servers, das Update einzuspielen.</p><p>{{companyName}} · {{fqdn}}</p>'
    },
    en: {
      subject: 'Zamfono {{version}} needs a manual update',
      bodyText:
        'Hi {{recipientName}},\n\nZamfono {{version}} is out{{#if publishedAt}} since {{date publishedAt}}{{/if}}. It is a breaking release, so {{fqdn}}, on {{currentVersion}}, does not install it on its own.\n\nRead its release notes{{#if releaseUrl}} ({{releaseUrl}}){{/if}}, then ask whoever runs your server to install the update.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Hi {{recipientName}},</p><p>Zamfono {{version}} is out{{#if publishedAt}} since {{date publishedAt}}{{/if}}. It is a breaking release, so {{fqdn}}, on {{currentVersion}}, does not install it on its own.</p><p>Read its release notes{{#if releaseUrl}} ({{releaseUrl}}){{/if}}, then ask whoever runs your server to install the update.</p><p>{{companyName}} · {{fqdn}}</p>'
    },
    es: {
      subject: 'Zamfono {{version}} requiere una actualización manual',
      bodyText:
        'Hola {{recipientName}},\n\nZamfono {{version}} ya está disponible{{#if publishedAt}} desde el {{date publishedAt}}{{/if}}. Es una versión con cambios incompatibles, así que {{fqdn}}, en {{currentVersion}}, no la instala por sí solo.\n\nLea sus notas de la versión{{#if releaseUrl}} ({{releaseUrl}}){{/if}} y pida después a quien gestiona su servidor que instale la actualización.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Hola {{recipientName}},</p><p>Zamfono {{version}} ya está disponible{{#if publishedAt}} desde el {{date publishedAt}}{{/if}}. Es una versión con cambios incompatibles, así que {{fqdn}}, en {{currentVersion}}, no la instala por sí solo.</p><p>Lea sus notas de la versión{{#if releaseUrl}} ({{releaseUrl}}){{/if}} y pida después a quien gestiona su servidor que instale la actualización.</p><p>{{companyName}} · {{fqdn}}</p>'
    },
    fr: {
      subject: 'Zamfono {{version}} demande une mise à jour manuelle',
      bodyText:
        "Bonjour {{recipientName}},\n\nZamfono {{version}} est disponible{{#if publishedAt}} depuis le {{date publishedAt}}{{/if}}. C'est une version avec des changements incompatibles : {{fqdn}}, en {{currentVersion}}, ne l'installe donc pas de lui-même.\n\nLisez ses notes de version{{#if releaseUrl}} ({{releaseUrl}}){{/if}}, puis demandez à la personne qui gère votre serveur d'installer la mise à jour.\n\n{{companyName}} · {{fqdn}}",
      bodyHtml:
        "<p>Bonjour {{recipientName}},</p><p>Zamfono {{version}} est disponible{{#if publishedAt}} depuis le {{date publishedAt}}{{/if}}. C'est une version avec des changements incompatibles : {{fqdn}}, en {{currentVersion}}, ne l'installe donc pas de lui-même.</p><p>Lisez ses notes de version{{#if releaseUrl}} ({{releaseUrl}}){{/if}}, puis demandez à la personne qui gère votre serveur d'installer la mise à jour.</p><p>{{companyName}} · {{fqdn}}</p>"
    },
    it: {
      subject: 'Zamfono {{version}} richiede un aggiornamento manuale',
      bodyText:
        "Ciao {{recipientName}},\n\nZamfono {{version}} è disponibile{{#if publishedAt}} dal {{date publishedAt}}{{/if}}. È una release con modifiche incompatibili, quindi {{fqdn}}, su {{currentVersion}}, non la installa da solo.\n\nLeggi le note di rilascio{{#if releaseUrl}} ({{releaseUrl}}){{/if}}, poi chiedi a chi gestisce il tuo server di installare l'aggiornamento.\n\n{{companyName}} · {{fqdn}}",
      bodyHtml:
        "<p>Ciao {{recipientName}},</p><p>Zamfono {{version}} è disponibile{{#if publishedAt}} dal {{date publishedAt}}{{/if}}. È una release con modifiche incompatibili, quindi {{fqdn}}, su {{currentVersion}}, non la installa da solo.</p><p>Leggi le note di rilascio{{#if releaseUrl}} ({{releaseUrl}}){{/if}}, poi chiedi a chi gestisce il tuo server di installare l'aggiornamento.</p><p>{{companyName}} · {{fqdn}}</p>"
    },
    ru: {
      subject: 'Zamfono {{version}} требует ручного обновления',
      bodyText:
        'Здравствуйте, {{recipientName}}!\n\nВышел Zamfono {{version}}{{#if publishedAt}} ({{date publishedAt}}){{/if}}. Это релиз с несовместимыми изменениями, поэтому {{fqdn}} на {{currentVersion}} не устанавливает его сам.\n\nПрочитайте примечания к релизу{{#if releaseUrl}} ({{releaseUrl}}){{/if}}, затем попросите того, кто обслуживает ваш сервер, установить обновление.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Здравствуйте, {{recipientName}}!</p><p>Вышел Zamfono {{version}}{{#if publishedAt}} ({{date publishedAt}}){{/if}}. Это релиз с несовместимыми изменениями, поэтому {{fqdn}} на {{currentVersion}} не устанавливает его сам.</p><p>Прочитайте примечания к релизу{{#if releaseUrl}} ({{releaseUrl}}){{/if}}, затем попросите того, кто обслуживает ваш сервер, установить обновление.</p><p>{{companyName}} · {{fqdn}}</p>'
    }
  },
  mfaChanged: {
    de: {
      subject: 'Zwei-Faktor-Anmeldung bei {{companyName}} geändert',
      bodyText:
        'Hallo {{recipientName}},\n\n{{#if added}}{{#if passkeyName}}Der Passkey „{{passkeyName}}“ wurde zu Ihrem Konto hinzugefügt{{else}}Für Ihr Konto wurde eine Authenticator-App eingerichtet{{/if}}{{/if}}{{#if removed}}{{#if passkeyName}}Der Passkey „{{passkeyName}}“ wurde aus Ihrem Konto entfernt{{else}}Die Authenticator-App wurde aus Ihrem Konto entfernt{{/if}}{{/if}}{{#if reset}}Ein Administrator hat die Zwei-Faktor-Anmeldung Ihres Kontos zurückgesetzt; Sie richten sie bei der nächsten Anmeldung neu ein{{/if}} – am {{date changedAt}}.\n\nFalls Sie das nicht waren, informieren Sie sofort Ihren Administrator.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Hallo {{recipientName}},</p><p>{{#if added}}{{#if passkeyName}}Der Passkey „{{passkeyName}}“ wurde zu Ihrem Konto hinzugefügt{{else}}Für Ihr Konto wurde eine Authenticator-App eingerichtet{{/if}}{{/if}}{{#if removed}}{{#if passkeyName}}Der Passkey „{{passkeyName}}“ wurde aus Ihrem Konto entfernt{{else}}Die Authenticator-App wurde aus Ihrem Konto entfernt{{/if}}{{/if}}{{#if reset}}Ein Administrator hat die Zwei-Faktor-Anmeldung Ihres Kontos zurückgesetzt; Sie richten sie bei der nächsten Anmeldung neu ein{{/if}} – am {{date changedAt}}.</p><p>Falls Sie das nicht waren, informieren Sie sofort Ihren Administrator.</p><p>{{companyName}} · {{fqdn}}</p>'
    },
    en: {
      subject: 'Two-factor sign-in changed for {{companyName}}',
      bodyText:
        'Hi {{recipientName}},\n\n{{#if added}}{{#if passkeyName}}The passkey “{{passkeyName}}” was added to your account{{else}}An authenticator app was set up for your account{{/if}}{{/if}}{{#if removed}}{{#if passkeyName}}The passkey “{{passkeyName}}” was removed from your account{{else}}The authenticator app was removed from your account{{/if}}{{/if}}{{#if reset}}An administrator reset the two-factor sign-in of your account; you set it up again at your next sign-in{{/if}} on {{date changedAt}}.\n\nIf this was not you, tell your administrator at once.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Hi {{recipientName}},</p><p>{{#if added}}{{#if passkeyName}}The passkey “{{passkeyName}}” was added to your account{{else}}An authenticator app was set up for your account{{/if}}{{/if}}{{#if removed}}{{#if passkeyName}}The passkey “{{passkeyName}}” was removed from your account{{else}}The authenticator app was removed from your account{{/if}}{{/if}}{{#if reset}}An administrator reset the two-factor sign-in of your account; you set it up again at your next sign-in{{/if}} on {{date changedAt}}.</p><p>If this was not you, tell your administrator at once.</p><p>{{companyName}} · {{fqdn}}</p>'
    },
    es: {
      subject: 'Inicio de sesión en dos pasos modificado en {{companyName}}',
      bodyText:
        'Hola {{recipientName}}:\n\n{{#if added}}{{#if passkeyName}}Se añadió la llave de acceso «{{passkeyName}}» a tu cuenta{{else}}Se configuró una app de autenticación para tu cuenta{{/if}}{{/if}}{{#if removed}}{{#if passkeyName}}Se eliminó la llave de acceso «{{passkeyName}}» de tu cuenta{{else}}Se eliminó la app de autenticación de tu cuenta{{/if}}{{/if}}{{#if reset}}Un administrador restableció el inicio de sesión en dos pasos de tu cuenta; lo configurarás de nuevo en tu próximo inicio de sesión{{/if}} el {{date changedAt}}.\n\nSi no fuiste tú, avisa de inmediato a tu administrador.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Hola {{recipientName}}:</p><p>{{#if added}}{{#if passkeyName}}Se añadió la llave de acceso «{{passkeyName}}» a tu cuenta{{else}}Se configuró una app de autenticación para tu cuenta{{/if}}{{/if}}{{#if removed}}{{#if passkeyName}}Se eliminó la llave de acceso «{{passkeyName}}» de tu cuenta{{else}}Se eliminó la app de autenticación de tu cuenta{{/if}}{{/if}}{{#if reset}}Un administrador restableció el inicio de sesión en dos pasos de tu cuenta; lo configurarás de nuevo en tu próximo inicio de sesión{{/if}} el {{date changedAt}}.</p><p>Si no fuiste tú, avisa de inmediato a tu administrador.</p><p>{{companyName}} · {{fqdn}}</p>'
    },
    fr: {
      subject: 'Connexion à deux facteurs modifiée pour {{companyName}}',
      bodyText:
        'Bonjour {{recipientName}},\n\n{{#if added}}{{#if passkeyName}}La clé d’accès « {{passkeyName}} » a été ajoutée à votre compte{{else}}Une application d’authentification a été configurée pour votre compte{{/if}}{{/if}}{{#if removed}}{{#if passkeyName}}La clé d’accès « {{passkeyName}} » a été supprimée de votre compte{{else}}L’application d’authentification a été supprimée de votre compte{{/if}}{{/if}}{{#if reset}}Un administrateur a réinitialisé la connexion à deux facteurs de votre compte ; vous la configurerez à nouveau lors de votre prochaine connexion{{/if}} le {{date changedAt}}.\n\nSi ce n’était pas vous, prévenez immédiatement votre administrateur.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Bonjour {{recipientName}},</p><p>{{#if added}}{{#if passkeyName}}La clé d’accès « {{passkeyName}} » a été ajoutée à votre compte{{else}}Une application d’authentification a été configurée pour votre compte{{/if}}{{/if}}{{#if removed}}{{#if passkeyName}}La clé d’accès « {{passkeyName}} » a été supprimée de votre compte{{else}}L’application d’authentification a été supprimée de votre compte{{/if}}{{/if}}{{#if reset}}Un administrateur a réinitialisé la connexion à deux facteurs de votre compte ; vous la configurerez à nouveau lors de votre prochaine connexion{{/if}} le {{date changedAt}}.</p><p>Si ce n’était pas vous, prévenez immédiatement votre administrateur.</p><p>{{companyName}} · {{fqdn}}</p>'
    },
    it: {
      subject: 'Accesso a due fattori modificato per {{companyName}}',
      bodyText:
        'Ciao {{recipientName}},\n\n{{#if added}}{{#if passkeyName}}La passkey «{{passkeyName}}» è stata aggiunta al tuo account{{else}}È stata configurata un’app di autenticazione per il tuo account{{/if}}{{/if}}{{#if removed}}{{#if passkeyName}}La passkey «{{passkeyName}}» è stata rimossa dal tuo account{{else}}L’app di autenticazione è stata rimossa dal tuo account{{/if}}{{/if}}{{#if reset}}Un amministratore ha reimpostato l’accesso a due fattori del tuo account; lo configurerai di nuovo al prossimo accesso{{/if}} il {{date changedAt}}.\n\nSe non sei stato tu, avvisa subito il tuo amministratore.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Ciao {{recipientName}},</p><p>{{#if added}}{{#if passkeyName}}La passkey «{{passkeyName}}» è stata aggiunta al tuo account{{else}}È stata configurata un’app di autenticazione per il tuo account{{/if}}{{/if}}{{#if removed}}{{#if passkeyName}}La passkey «{{passkeyName}}» è stata rimossa dal tuo account{{else}}L’app di autenticazione è stata rimossa dal tuo account{{/if}}{{/if}}{{#if reset}}Un amministratore ha reimpostato l’accesso a due fattori del tuo account; lo configurerai di nuovo al prossimo accesso{{/if}} il {{date changedAt}}.</p><p>Se non sei stato tu, avvisa subito il tuo amministratore.</p><p>{{companyName}} · {{fqdn}}</p>'
    },
    ru: {
      subject: 'Двухфакторный вход в {{companyName}} изменён',
      bodyText:
        'Здравствуйте, {{recipientName}}!\n\n{{#if added}}{{#if passkeyName}}К вашей учётной записи добавлен ключ доступа «{{passkeyName}}»{{else}}Для вашей учётной записи настроено приложение-аутентификатор{{/if}}{{/if}}{{#if removed}}{{#if passkeyName}}Из вашей учётной записи удалён ключ доступа «{{passkeyName}}»{{else}}Из вашей учётной записи удалено приложение-аутентификатор{{/if}}{{/if}}{{#if reset}}Администратор сбросил двухфакторный вход вашей учётной записи; вы настроите его заново при следующем входе{{/if}} — {{date changedAt}}.\n\nЕсли это были не вы, немедленно сообщите администратору.\n\n{{companyName}} · {{fqdn}}',
      bodyHtml:
        '<p>Здравствуйте, {{recipientName}}!</p><p>{{#if added}}{{#if passkeyName}}К вашей учётной записи добавлен ключ доступа «{{passkeyName}}»{{else}}Для вашей учётной записи настроено приложение-аутентификатор{{/if}}{{/if}}{{#if removed}}{{#if passkeyName}}Из вашей учётной записи удалён ключ доступа «{{passkeyName}}»{{else}}Из вашей учётной записи удалено приложение-аутентификатор{{/if}}{{/if}}{{#if reset}}Администратор сбросил двухфакторный вход вашей учётной записи; вы настроите его заново при следующем входе{{/if}} — {{date changedAt}}.</p><p>Если это были не вы, немедленно сообщите администратору.</p><p>{{companyName}} · {{fqdn}}</p>'
    }
  }
};
