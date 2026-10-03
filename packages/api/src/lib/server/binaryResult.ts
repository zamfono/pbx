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
