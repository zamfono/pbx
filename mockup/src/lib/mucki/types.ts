/**
 * Mucki's conversation as data: the messages a panel renders and a history persists. Every text is
 * rendered in the language of the turn that produced it.
 */
import type { PersonaKey } from '#lib/api/seed/ids.js';

/** A quick reply under a question, or a suggestion chip under the composer. */
export type Chip = {
  label: string;
  /** What the chip sends; the label when omitted. */
  prompt?: string;
  /** Puts `prompt` into the composer instead of sending it. */
  paste?: boolean;
};

export type ToolState =
  'running' | 'awaiting' | 'done' | 'refused' | 'error' | 'cancelled';

export type UserMessage = { kind: 'user'; id: string; text: string };

export type AssistantMessage = {
  kind: 'assistant';
  id: string;
  /** Light markdown: **bold**, `code`, lists, [links](/path). */
  text: string;
  streaming?: boolean;
  /** Quick replies of a question; dropped once answered. */
  options?: Chip[];
};

export type ToolMessage = {
  kind: 'tool';
  id: string;
  operation: string;
  input: unknown;
  state: ToolState;
  /** One line in plain words: what is running, or what it did. */
  summary: string;
  /** The raw result (Expert mode), JSON, shortened. */
  result?: string;
  /** The refusal's status and code (Expert mode). */
  error?: { status: number; code: string; message: string };
};

export type ConfirmMessage = {
  kind: 'confirm';
  id: string;
  operation: string;
  title: string;
  body: string;
  action: string;
  irreversible: boolean;
  destructive: boolean;
  state: 'pending' | 'confirmed' | 'cancelled';
};

export type RefusalMessage = { kind: 'refusal'; id: string; text: string };

export type ErrorMessage = { kind: 'error'; id: string; text: string };

export type LinkMessage = {
  kind: 'link';
  id: string;
  path: string;
  highlight?: string;
  /** What the link opens, e.g. "Tom Becker". */
  label: string;
};

export type SecretMessage = {
  kind: 'secret';
  id: string;
  label: string;
  value: string;
  note?: string;
};

export type ProgressItem = {
  label: string;
  state: 'pending' | 'running' | 'done' | 'failed';
  note?: string;
};

export type ProgressMessage = {
  kind: 'progress';
  id: string;
  /** i18n key with `{done}` and `{total}`, rendered live. */
  labelKey: string;
  /** The operation each row runs (Expert mode). */
  operation?: string;
  items: ProgressItem[];
  finished: boolean;
};

export type AudioMessage = {
  kind: 'audio';
  id: string;
  clip: string | null;
  durationS: number;
  title: string;
  stereo?: boolean;
};

export type Message =
  | UserMessage
  | AssistantMessage
  | ToolMessage
  | ConfirmMessage
  | RefusalMessage
  | ErrorMessage
  | LinkMessage
  | SecretMessage
  | ProgressMessage
  | AudioMessage;

/** A message as added: the engine assigns the id. */
export type NewMessage = Message extends infer M
  ? M extends Message
    ? Omit<M, 'id'>
    : never
  : never;

export type Histories = Record<PersonaKey, Message[]>;
