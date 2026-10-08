import type { Messages } from '../index.svelte';

export default {
  de: {
    'blocklist.subtitle':
      'Anrufe von diesen Nummern oder Nummernbereichen werden abgewiesen.',
    'blocklist.add': 'Nummer sperren',
    'blocklist.match': 'Treffer',
    'blocklist.prefix': 'beginnt mit',
    'blocklist.exact': 'genau',
    'blocklist.prefixSwitch': 'Alle Nummern sperren, die so beginnen',
    'blocklist.labelPlaceholder': 'z. B. Werbeanrufe',
    'blocklist.empty': 'Keine gesperrten Nummern',
    'blocklist.emptyBody':
      'Sperren Sie lästige Anrufer – einzelne Nummern oder ganze Bereiche.',
    'blocklist.created': '{number} gesperrt',
    'blocklist.deleted': 'Sperre aufgehoben',
    'confirm.blockedNumbers.delete.title': 'Sperre aufheben?',
    'confirm.blockedNumbers.delete.body':
      'Anrufe von {number} kommen danach wieder durch.',
    'confirm.blockedNumbers.delete.action': 'Sperre aufheben',
    'field.blockedNumber.number': 'Rufnummer',
    'field.blockedNumber.number.help':
      'Im internationalen Format; 089 … wird zu +4989 ….',
    'field.blockedNumber.isPrefix': 'Nummernbereich',
    'field.blockedNumber.label': 'Notiz'
  },
  en: {
    'blocklist.subtitle':
      'Calls from these numbers or number ranges are refused.',
    'blocklist.add': 'Block a number',
    'blocklist.match': 'Match',
    'blocklist.prefix': 'starts with',
    'blocklist.exact': 'exact',
    'blocklist.prefixSwitch': 'Block every number that starts like this',
    'blocklist.labelPlaceholder': 'e.g. telemarketing',
    'blocklist.empty': 'No blocked numbers',
    'blocklist.emptyBody':
      'Block nuisance callers, one number or a whole range.',
    'blocklist.created': '{number} blocked',
    'blocklist.deleted': 'Block lifted',
    'confirm.blockedNumbers.delete.title': 'Lift the block?',
    'confirm.blockedNumbers.delete.body':
      'Calls from {number} come through again afterwards.',
    'confirm.blockedNumbers.delete.action': 'Lift block',
    'field.blockedNumber.number': 'Number',
    'field.blockedNumber.number.help':
      'International format; 089 … becomes +4989 ….',
    'field.blockedNumber.isPrefix': 'Number range',
    'field.blockedNumber.label': 'Note'
  }
} satisfies Messages;
