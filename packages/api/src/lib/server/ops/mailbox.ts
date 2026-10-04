import { z } from 'zod';

/** A mailbox's message limit (§11.5), the field a user and a ring group both carry. */
export const mailboxMaxMessagesField = {
  mailboxMaxMessages: z
    .number()
    .int()
    .positive()
    .nullish()
    .describe(
      'Most messages the mailbox holds; a caller reaching a full mailbox hears that it is full and leaves none; 100 by default; null: no limit.'
    )
};
