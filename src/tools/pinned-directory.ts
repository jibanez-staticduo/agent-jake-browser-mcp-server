import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';

export async function openPinnedDirectory(configuredPath: string): Promise<{ root: string; handle: FileHandle }> {
  if (process.platform !== 'linux') {
    throw new Error('Secure file operations require Linux directory file descriptors');
  }
  const configured = await lstat(configuredPath);
  if (!configured.isDirectory()) throw new Error('Configured path is not a directory');
  const root = await realpath(configuredPath);
  const before = await lstat(root);
  if (!before.isDirectory() || configured.dev !== before.dev || configured.ino !== before.ino) {
    throw new Error('Configured directory changed before it could be opened');
  }
  const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error('Configured directory changed before it could be opened');
    }
    return { root, handle };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export function pinnedChildPath(handle: FileHandle, name: string): string {
  return `/proc/self/fd/${handle.fd}/${name}`;
}
