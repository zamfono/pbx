import { z } from 'zod';

import {
  DEFAULT_VONAGE_SAMPLE_RATE,
  isTemplate,
  targetFieldProblem,
  templateSample,
  TWILIO_SAMPLE_RATE,
  urlLiteralProblem,
  WEB_SOCKET_URL_MAX_LENGTH,
  type WebSocketProtocol,
  type WebSocketSampleRate
} from '@zamfono/shared';

/**
 * A target field that takes a template (§9.4 "Templates"): a value that is none must pass
 * `isValue`, else it is refused for `message`; a template is refused for what makes it none.
 * Only an admin sets a template (`forwardTargets.ts`), and the names it reads are checked as the
 * target is written (`templateNames.ts`).
 */
export function templatedField(
  field: 'external' | 'user' | 'extension',
  isValue: (value: string) => boolean,
  message: string
): z.ZodString {
  return z.string().superRefine((value, ctx) => {
    if (!isTemplate(value)) {
      if (!isValue(value)) {
        ctx.addIssue({ code: 'custom', message });
      }
      return;
    }
    const problem = targetFieldProblem(field, value);
    if (problem !== null) {
      ctx.addIssue({ code: 'custom', message: `${field} has ${problem}` });
    }
  });
}

/** A URL a `webSocket` target may connect to (§9.4 "WebSocket targets"); `forward_targets`' CHECK
 * holds the same. An address literal no connection could reach, and a public one under plain
 * `ws://`, is refused at once (§3.1 "Outbound targets"). */
const literalWebSocketUrl = z
  .url({ protocol: /^wss?$/u, hostname: z.regexes.hostname })
  .superRefine((url, ctx) => {
    const problem = urlLiteralProblem(url);
    if (problem !== null) {
      ctx.addIssue({ code: 'custom', message: problem });
    }
  });

/** A `webSocket` target's `url`: a URL as above, or a template of one whose scheme, host and port
 * are literal (§9.4 "Templates"), checked as the URL it is with each placeholder filled in. */
export const webSocketUrlSchema = z
  .string()
  .max(WEB_SOCKET_URL_MAX_LENGTH)
  .superRefine((value, ctx) => {
    const problem = isTemplate(value) ? targetFieldProblem('url', value) : null;
    if (problem !== null) {
      ctx.addIssue({ code: 'custom', message: `url has ${problem}` });
      return;
    }
    const checked = literalWebSocketUrl.safeParse(templateSample(value));
    for (const issue of checked.error?.issues ?? []) {
      ctx.addIssue({ code: 'custom', message: issue.message });
    }
  })
  .describe(
    "The bot's WebSocket URL, wss://, or ws:// for a bot on a private network, at most 2048 characters; a token the bot checks goes in its query string. Past the host it may be a template (see zamfono.help templates)."
  );

/** The sample rate a `webSocket` target speaks at (§9.4 "WebSocket targets"): `twilio` always 8000,
 * `vonage` the one given, 16000 unless given. */
export function webSocketSampleRate(target: {
  protocol: WebSocketProtocol;
  sampleRate?: WebSocketSampleRate | undefined;
}): WebSocketSampleRate {
  return (
    target.sampleRate ??
    (target.protocol === 'twilio'
      ? TWILIO_SAMPLE_RATE
      : DEFAULT_VONAGE_SAMPLE_RATE)
  );
}
