/**
 * Serves the extension zip with the server address baked in.
 *
 * The template zip mounted in the container is read-only and build-time neutral,
 * so the download route injects a root-level `config.json` on the fly: each
 * install then downloads an extension that already points at its own domain.
 * Only the URL goes in there — tokens are handled by pairing.
 */
import AdmZip from 'adm-zip';
import path from 'node:path';

export interface ExtensionConfig {
  version: 1;
  wsUrl: string;
}

export interface PatchedZip {
  buffer: Buffer;
  /** Zip entry that was written, e.g. `config.json`. */
  entryName: string;
  /** True when the entry already existed in the template. */
  replaced: boolean;
}

/**
 * Exact JSON stored in the extension: keep the shape stable, the extension reads it.
 */
export function extensionConfigJson(wsUrl: string): string {
  const config: ExtensionConfig = { version: 1, wsUrl };
  return JSON.stringify(config);
}

/**
 * config.json has to sit next to manifest.json. Templates keep it at the zip root;
 * a nested build gets its sibling instead.
 */
export function configEntryName(entryNames: string[]): string {
  const manifestAtRoot = entryNames.includes('manifest.json');
  if (manifestAtRoot) return 'config.json';

  const nestedManifest = entryNames.find(
    (name) => name.endsWith('manifest.json') && !name.startsWith('.vite/'),
  );
  if (!nestedManifest) return 'config.json';

  const dir = path.posix.dirname(nestedManifest);
  return dir === '.' || dir === '' ? 'config.json' : `${dir}/config.json`;
}

/**
 * Return a copy of `zipBuffer` with config.json injected or updated in place.
 * The source buffer is never written to disk.
 */
export function patchZipConfig(zipBuffer: Buffer, wsUrl: string): PatchedZip {
  const zip = new AdmZip(zipBuffer);
  const entryNames = zip
    .getEntries()
    .filter((entry) => !entry.isDirectory)
    .map((entry) => entry.entryName);

  const entryName = configEntryName(entryNames);
  const data = Buffer.from(extensionConfigJson(wsUrl), 'utf-8');
  const replaced = entryNames.includes(entryName);

  if (replaced) {
    zip.updateFile(entryName, data);
  } else {
    zip.addFile(entryName, data);
  }

  return { buffer: zip.toBuffer(), entryName, replaced };
}
