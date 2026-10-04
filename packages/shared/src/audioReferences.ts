import type { Db } from './db.js';

/**
 * The live rows that reference audio asset `audioId` (§5.9, §11.2), one query per table holding
 * an audio column, each selecting `id`: what refuses the asset's delete, and what keeps a
 * replaced mailbox greeting.
 */
export function audioReferenceQueries(db: Db, audioId: string) {
  return {
    ringGroups: db
      .selectFrom('ringGroups')
      .select('id')
      .where('deletedAt', 'is', null)
      .where(eb =>
        eb.or([
          eb('greetingAudioId', '=', audioId),
          eb('mohAudioId', '=', audioId),
          eb('mailboxAudioId', '=', audioId)
        ])
      ),
    users: db
      .selectFrom('users')
      .select('id')
      .where('deletedAt', 'is', null)
      .where('mailboxAudioId', '=', audioId),
    menus: db
      .selectFrom('menus')
      .select('id')
      .where('deletedAt', 'is', null)
      .where('audioId', '=', audioId),
    settings: db
      .selectFrom('settings')
      .select('id')
      .where('holdMohAudioId', '=', audioId),
    forwardTargets: db
      .selectFrom('forwardTargets')
      .select('id')
      .where('announcementAudioId', '=', audioId)
  };
}
