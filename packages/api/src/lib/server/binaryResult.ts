/**
 * A file an operation returns (§10.3 `voicemails.audio`, `recordings.audio`): REST answers it as
 * the bytes themselves, with its content type and file name, rather than as JSON.
 */
export class BinaryResult {
  constructor(
    readonly bytes: Buffer,
    readonly contentType: string,
    readonly filename: string
  ) {}
}
