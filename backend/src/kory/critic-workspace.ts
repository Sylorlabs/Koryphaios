import { constants } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { canonicalizePath } from '../runtime/platform';

/** Independent writable verification copy, including installed dependencies.
 * Dereference links so a test cannot write through a link into the producer's
 * checkout. Never bring linked Git metadata or Kory control state into a copy. */
export async function createCriticWorkspace(source: string): Promise<string> {
  const directory = canonicalizePath(await mkdtemp(join(tmpdir(), 'kory-critic-')));
  try {
    await cp(source, directory, {
      recursive: true,
      dereference: true,
      mode: constants.COPYFILE_FICLONE,
      filter: (path) => !relative(source, path).split(/[\\/]/).some(
        (part) => ['.git', '.trees', '.koryphaios', '.svelte-kit'].includes(part),
      ),
    });
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
