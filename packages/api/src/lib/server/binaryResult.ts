import { z } from 'zod';

/**
 * A file an operation returns (§10.3 `voicemails.audio`, `recordings.audio`): REST answers it as
 * the bytes themselves, with its content type and file name, rather than as JSON; MCP answers it
 * with a download link (§10.5), so the file is read, and a transcode run, only by `read`.
 */
export class BinaryResult {
  constructor(
    readonly contentType: string,
    readonly filename: string,
    readonly read: () => Promise<Buffer>
  ) {}
}

/** The media types a `binaryOutput` schema's file comes in, for the OpenAPI response. */
export const binaryMediaTypes = z.registry<{ mediaTypes: readonly string[] }>();

/** The `output` of an operation answering with a file in one of `mediaTypes`. */
export function binaryOutput(
  mediaTypes: readonly string[]
): z.ZodType<BinaryResult> {
  const schema = z.instanceof(BinaryResult);
  binaryMediaTypes.add(schema, { mediaTypes });
  return schema;
}
