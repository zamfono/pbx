/** A `.catch` handler for a file system call on a path that may not exist, such as a media
 * directory nothing has been written to yet or a file another sweep removed: drops that outcome
 * (`ENOENT`) and rethrows every other failure, the counterpart of `ari/failures.ts`'s
 * `ignoreGone`. */
export function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
    throw error;
  }
}
