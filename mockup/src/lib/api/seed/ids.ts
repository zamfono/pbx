/**
 * The seed's named rows, so the seed files, Mucki's scenarios and the simulator refer to the same
 * people, groups and numbers by name.
 */
import { seedId } from '../ids';

export const U = {
  lea: seedId('user:lea'),
  jonas: seedId('user:jonas'),
  mira: seedId('user:mira'),
  felix: seedId('user:felix'),
  sophie: seedId('user:sophie'),
  daniel: seedId('user:daniel'),
  aylin: seedId('user:aylin'),
  tobias: seedId('user:tobias'),
  empfang: seedId('user:empfang'),
  laura: seedId('user:laura'),
  markus: seedId('user:markus'),
  katrin: seedId('user:katrin'),
  nina: seedId('user:nina'),
  petra: seedId('user:petra')
} as const;

export const UG = {
  beratung: seedId('userGroup:beratung'),
  buchhaltung: seedId('userGroup:buchhaltung'),
  sekretariat: seedId('userGroup:sekretariat'),
  alle: seedId('userGroup:alle')
} as const;

export const RG = {
  empfang: seedId('ringGroup:empfang'),
  beratung: seedId('ringGroup:beratung'),
  buchhaltung: seedId('ringGroup:buchhaltung'),
  support: seedId('ringGroup:support')
} as const;

export const MENU = { haupt: seedId('menu:haupt') } as const;

export const DID = {
  main: seedId('did:main'),
  hotline: seedId('did:hotline'),
  lea: seedId('did:lea'),
  jonas: seedId('did:jonas'),
  mira: seedId('did:mira'),
  felix: seedId('did:felix'),
  daniel: seedId('did:daniel'),
  buchhaltung: seedId('did:buchhaltung')
} as const;

export const BLOCK = { main: seedId('didBlock:main') } as const;

export const TRUNK = { nordwind: seedId('trunk:nordwind') } as const;

export const ROUTE = { catchAll: seedId('route:catchAll') } as const;

export const AUDIO = {
  greetingEmpfang: seedId('audio:greetingEmpfang'),
  greetingSupport: seedId('audio:greetingSupport'),
  mohLounge: seedId('audio:mohLounge'),
  mohPiano: seedId('audio:mohPiano'),
  mohAcoustic: seedId('audio:mohAcoustic'),
  mohAmbient: seedId('audio:mohAmbient'),
  mohJazz: seedId('audio:mohJazz'),
  vmEmpfang: seedId('audio:vmEmpfang'),
  vmSupport: seedId('audio:vmSupport'),
  annMenu: seedId('audio:annMenu'),
  annHoliday: seedId('audio:annHoliday'),
  annClosed: seedId('audio:annClosed')
} as const;

export const HOURS = {
  tenant: seedId('hours:tenant'),
  support: seedId('hours:support')
} as const;

export const OOO = {
  holidays: seedId('ooo:holidays'),
  felixVacation: seedId('ooo:felixVacation')
} as const;

export const BACKUP = {
  nas: seedId('backup:nas'),
  s3: seedId('backup:s3')
} as const;

export const WEBHOOK = { crm: seedId('webhook:crm') } as const;

/** The demo personas: who the demo bar signs in as. */
export const PERSONAS = [
  { key: 'lea', userId: U.lea },
  { key: 'jonas', userId: U.jonas },
  { key: 'mira', userId: U.mira }
] as const;
export type PersonaKey = (typeof PERSONAS)[number]['key'];

/** The company's numbers (E.164). */
export const NUM = {
  main: '+498945200',
  blockBase: '+49894520',
  hotline: '+49894520500'
} as const;
