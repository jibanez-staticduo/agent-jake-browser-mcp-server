import { describe, expect, it } from 'vitest';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openPinnedDirectory, pinnedChildPath } from '../src/tools/pinned-directory.js';

describe.skipIf(process.platform !== 'linux')('pinned directory', () => {
  it('rejects a configured symlink root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pinned-root-'));
    const link = `${root}-link`;
    await symlink(root, link);
    await expect(openPinnedDirectory(link)).rejects.toThrow('Configured path is not a directory');
  });

  it('keeps reads and writes in the opened directory after its path is replaced', async () => {
    const base = await mkdtemp(join(tmpdir(), 'pinned-'));
    const root = join(base, 'drop');
    const privateDir = join(base, 'private');
    await mkdir(root);
    await mkdir(privateDir);
    await writeFile(join(root, 'source.txt'), 'approved');
    await writeFile(join(privateDir, 'source.txt'), 'private');

    const { handle } = await openPinnedDirectory(root);
    try {
      const moved = join(base, 'moved');
      await rename(root, moved);
      await symlink(privateDir, root);
      expect(await readFile(pinnedChildPath(handle, 'source.txt'), 'utf8')).toBe('approved');
      const output = await open(pinnedChildPath(handle, 'new.txt'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW);
      try {
        await output.writeFile('safe');
      } finally {
        await output.close();
      }
      expect(await readFile(join(moved, 'new.txt'), 'utf8')).toBe('safe');
      await expect(readFile(join(privateDir, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await handle.close();
    }
  });
});
