/**
 * The extension build the CI published to this server after a merge to main of
 * agent-browser-extension: `latest.json` describes it and the zip next to it is what
 * /download serves. Every installed extension reads latest.json when the browser starts and
 * every 30 minutes, and tells its user when a newer build exists.
 *
 * The CI writes both files into the pod (BROWSER_EXTENSION_DIR, on the PVC); this module only
 * reads them, and a missing or malformed latest.json reads as "nothing published".
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const PUBLISHED_ZIP_NAME = 'agent-jake-browser-extension.zip';

export interface PublishedVersion {
  /** Manifest version, e.g. "2.4.0.118". */
  version: string;
  /** Monotonic build number on main (commit count): what extensions compare. */
  build: number;
  sha: string;
  publishedAt: string;
}

export function readPublishedVersion(dir: string): PublishedVersion | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, 'latest.json'), 'utf-8')) as Partial<PublishedVersion>;
    if (typeof raw.version !== 'string' || !raw.version) return null;
    if (typeof raw.build !== 'number' || !Number.isInteger(raw.build) || raw.build < 1) return null;
    if (typeof raw.sha !== 'string' || typeof raw.publishedAt !== 'string') return null;
    return { version: raw.version, build: raw.build, sha: raw.sha, publishedAt: raw.publishedAt };
  } catch {
    return null;
  }
}

/** The zip /download serves: an explicit BROWSER_EXTENSION_ZIP, else the published one, else the image's. */
export function extensionZipPath(env: NodeJS.ProcessEnv, dir: string): string {
  if (env.BROWSER_EXTENSION_ZIP) return env.BROWSER_EXTENSION_ZIP;
  const published = path.join(dir, PUBLISHED_ZIP_NAME);
  return existsSync(published) ? published : '/app/extension/agent-jake-browser-extension.zip';
}
