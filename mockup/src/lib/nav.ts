/**
 * Every page of the app: its route patterns (the files under src/routes/(app)/), where it sits in
 * the sidebar, and who sees it. Visibility mirrors the operations a page is built on: a page whose
 * operations need `admin` is an admin page; `ownerOnly` pages run owner-only operations alone;
 * `expertOnly` pages appear in Expert mode.
 */
import Activity from '@lucide/svelte/icons/activity';
import AudioLines from '@lucide/svelte/icons/audio-lines';
import BookUser from '@lucide/svelte/icons/book-user';
import Cable from '@lucide/svelte/icons/cable';
import CalendarClock from '@lucide/svelte/icons/calendar-clock';
import ChartColumn from '@lucide/svelte/icons/chart-column';
import Cloud from '@lucide/svelte/icons/cloud';
import DatabaseBackup from '@lucide/svelte/icons/database-backup';
import Disc3 from '@lucide/svelte/icons/disc-3';
import Hash from '@lucide/svelte/icons/hash';
import History from '@lucide/svelte/icons/history';
import LayoutDashboard from '@lucide/svelte/icons/layout-dashboard';
import Mail from '@lucide/svelte/icons/mail';
import Network from '@lucide/svelte/icons/network';
import PhoneCall from '@lucide/svelte/icons/phone-call';
import PhoneOff from '@lucide/svelte/icons/phone-off';
import Plug from '@lucide/svelte/icons/plug';
import RadioTower from '@lucide/svelte/icons/radio-tower';
import Route from '@lucide/svelte/icons/route';
import ScrollText from '@lucide/svelte/icons/scroll-text';
import Server from '@lucide/svelte/icons/server';
import Settings from '@lucide/svelte/icons/settings';
import ShieldAlert from '@lucide/svelte/icons/shield-alert';
import SquareParking from '@lucide/svelte/icons/square-parking';
import UserCog from '@lucide/svelte/icons/user-cog';
import Users from '@lucide/svelte/icons/users';
import UsersRound from '@lucide/svelte/icons/users-round';
import Voicemail from '@lucide/svelte/icons/voicemail';
import Workflow from '@lucide/svelte/icons/workflow';
import type { Component } from 'svelte';

import type { Role } from '#lib/api/types.js';

export type NavSection =
  'phone' | 'telephony' | 'organisation' | 'routing' | 'system';

export type PageDef = {
  id: string;
  /** Route patterns; the first is the sidebar link. `:name?` is optional. */
  patterns: string[];
  section: NavSection;
  /** i18n key of the sidebar label and default page title. */
  label: string;
  icon: Component;
  minRole: Role;
  ownerOnly?: boolean;
  expertOnly?: boolean;
  /** Shown in the phone's bottom tab bar. */
  tab?: boolean;
};

export const PAGES: PageDef[] = [
  {
    id: 'overview',
    patterns: ['/overview'],
    section: 'phone',
    label: 'nav.overview',
    icon: LayoutDashboard,
    minRole: 'user',
    tab: true
  },
  {
    id: 'calls',
    patterns: ['/calls'],
    section: 'phone',
    label: 'nav.calls',
    icon: PhoneCall,
    minRole: 'user',
    tab: true
  },
  {
    id: 'voicemail',
    patterns: ['/voicemail'],
    section: 'phone',
    label: 'nav.voicemail',
    icon: Voicemail,
    minRole: 'user',
    tab: true
  },
  {
    id: 'me',
    patterns: ['/me/:tab?'],
    section: 'phone',
    label: 'nav.me',
    icon: UserCog,
    minRole: 'user',
    tab: true
  },
  {
    id: 'phonebook',
    patterns: ['/phonebook'],
    section: 'phone',
    label: 'nav.phonebook',
    icon: BookUser,
    minRole: 'user'
  },

  {
    id: 'live',
    patterns: ['/live'],
    section: 'telephony',
    label: 'nav.live',
    icon: Activity,
    minRole: 'admin'
  },
  {
    id: 'history',
    patterns: ['/history', '/history/:id'],
    section: 'telephony',
    label: 'nav.history',
    icon: History,
    minRole: 'admin'
  },
  {
    id: 'recordings',
    patterns: ['/recordings'],
    section: 'telephony',
    label: 'nav.recordings',
    icon: Disc3,
    minRole: 'admin'
  },
  {
    id: 'stats',
    patterns: ['/stats'],
    section: 'telephony',
    label: 'nav.stats',
    icon: ChartColumn,
    minRole: 'admin'
  },

  {
    id: 'users',
    patterns: ['/users', '/users/:id/:tab?'],
    section: 'organisation',
    label: 'nav.users',
    icon: Users,
    minRole: 'admin'
  },
  {
    id: 'userGroups',
    patterns: ['/user-groups', '/user-groups/:id'],
    section: 'organisation',
    label: 'nav.userGroups',
    icon: UsersRound,
    minRole: 'admin'
  },
  {
    id: 'ringGroups',
    patterns: ['/ring-groups', '/ring-groups/:id/:tab?'],
    section: 'organisation',
    label: 'nav.ringGroups',
    icon: RadioTower,
    minRole: 'admin'
  },
  {
    id: 'menus',
    patterns: ['/menus', '/menus/:id/:tab?'],
    section: 'organisation',
    label: 'nav.menus',
    icon: Workflow,
    minRole: 'admin'
  },
  {
    id: 'audio',
    patterns: ['/audio'],
    section: 'organisation',
    label: 'nav.audio',
    icon: AudioLines,
    minRole: 'admin'
  },

  {
    id: 'numbers',
    patterns: ['/numbers/:tab?'],
    section: 'routing',
    label: 'nav.numbers',
    icon: Hash,
    minRole: 'admin'
  },
  {
    id: 'companyHours',
    patterns: ['/company-hours'],
    section: 'routing',
    label: 'nav.companyHours',
    icon: CalendarClock,
    minRole: 'admin'
  },
  {
    id: 'outboundRoutes',
    patterns: ['/outbound-routes'],
    section: 'routing',
    label: 'nav.outboundRoutes',
    icon: Route,
    minRole: 'admin'
  },
  {
    id: 'trunks',
    patterns: ['/trunks', '/trunks/:id'],
    section: 'routing',
    label: 'nav.trunks',
    icon: Cable,
    minRole: 'admin'
  },
  {
    id: 'parking',
    patterns: ['/parking'],
    section: 'routing',
    label: 'nav.parking',
    icon: SquareParking,
    minRole: 'admin'
  },
  {
    id: 'blocklist',
    patterns: ['/blocklist'],
    section: 'routing',
    label: 'nav.blocklist',
    icon: PhoneOff,
    minRole: 'admin'
  },

  {
    id: 'settings',
    patterns: ['/settings/:tab?'],
    section: 'system',
    label: 'nav.settings',
    icon: Settings,
    minRole: 'admin'
  },
  {
    id: 'mailTemplates',
    patterns: ['/mail-templates'],
    section: 'system',
    label: 'nav.mailTemplates',
    icon: Mail,
    minRole: 'admin'
  },
  {
    id: 'integrations',
    patterns: ['/integrations'],
    section: 'system',
    label: 'nav.integrations',
    icon: Plug,
    minRole: 'admin'
  },
  {
    id: 'backups',
    patterns: ['/backups'],
    section: 'system',
    label: 'nav.backups',
    icon: DatabaseBackup,
    minRole: 'admin'
  },
  {
    id: 'audit',
    patterns: ['/audit'],
    section: 'system',
    label: 'nav.audit',
    icon: ScrollText,
    minRole: 'admin'
  },
  {
    id: 'system',
    patterns: ['/system'],
    section: 'system',
    label: 'nav.system',
    icon: Server,
    minRole: 'admin'
  },
  {
    id: 'ringotel',
    patterns: ['/ringotel'],
    section: 'system',
    label: 'nav.ringotel',
    icon: Cloud,
    minRole: 'owner',
    ownerOnly: true
  },
  {
    id: 'sipProtection',
    patterns: ['/sip-protection'],
    section: 'system',
    label: 'nav.sipProtection',
    icon: ShieldAlert,
    minRole: 'admin',
    expertOnly: true
  }
];

export const SECTIONS: { id: NavSection; label: string; icon: Component }[] = [
  { id: 'phone', label: 'nav.section.phone', icon: PhoneCall },
  { id: 'telephony', label: 'nav.section.telephony', icon: Network },
  { id: 'organisation', label: 'nav.section.organisation', icon: Users },
  { id: 'routing', label: 'nav.section.routing', icon: Route },
  { id: 'system', label: 'nav.section.system', icon: Settings }
];

const RANK: Record<Role, number> = { owner: 0, admin: 1, user: 2 };

export function visiblePages(role: Role, expert: boolean): PageDef[] {
  return PAGES.filter(
    page =>
      RANK[role] <= RANK[page.minRole] && (expert || page.expertOnly !== true)
  );
}
