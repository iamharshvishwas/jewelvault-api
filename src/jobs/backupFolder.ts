// B2, D25: the backup folder, as the tick's photo copy needs it. The TypeScript twin of what the database half wrote for the same folder in scripts/backup-folder.mjs (MB05: `resolveBackupDir`,
// `folderStats`) and scripts/backup.mjs (MB03: `directoryPhotos`): src cannot import scripts/*.mjs (the build's rootDir is src), so the application's code has its own, and
// tests/api/backup-twins.test.ts keeps each equal to its script (the same answers, the same words in an error, the same files). A change to a script is a change here.
//
// The folder is named by ONE variable, JV_BACKUP_DIR, an absolute path with the same value for the app and for cron; `~` and os.homedir() are never used, because in the app homedir() is the
// domain folder and in a cron job HOME is /home/<user> (B2). Three sub-folders: daily/ and monthly/ are the dump's (API34), photos/ is the photo copy's: `photos/<photo id>-<kind>`, written once.
//
// What is NOT in the twin: `assertFolderUsable` is new here and is only the photo copy's own question ("is there a folder I may write to?"). The check of B2 that the dashboard line turns red for
// a missing or unwritable folder (every hourly run and the start-up check) is API34's; this phase simply fails, loudly, when the folder is not there, and never makes the folder itself: a missing
// folder is never read as "nothing to copy", and a folder made quietly again after a domain was connected would hide that the exports in the old one are gone.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, link, mkdir, open, readFile, readdir, stat, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';

export const SUBFOLDERS = ['daily', 'monthly', 'photos'] as const;

/**
 * JV_BACKUP_DIR: an absolute path. Never `~` and never os.homedir(): in the app homedir() is the domain folder, in a cron job HOME is /home/<user>, and the two jobs must name the same folder.
 * Returns the normalised path; throws a message the start-up check can show.
 */
export function resolveBackupDir(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) throw new Error('JV_BACKUP_DIR is not set');
  if (raw.includes('~')) throw new Error('JV_BACKUP_DIR must not contain "~" (the app and cron resolve it differently); use the full path');
  if (!path.isAbsolute(raw)) throw new Error('JV_BACKUP_DIR must be an absolute path');
  if (raw.split('/').includes('..')) throw new Error('JV_BACKUP_DIR must not contain ".."');
  const dir = path.normalize(raw).replace(/\/+$/, '');
  if (dir === '' || dir === '/') throw new Error('JV_BACKUP_DIR must not be the root folder');
  return dir;
}

/**
 * The folder is there, it is a folder, and this process may write into it. Throws the error of the file system (`code` ENOENT, ENOTDIR, EACCES), or ENOTDIR for a file. It never makes the folder.
 */
export async function assertFolderUsable(dir: string): Promise<void> {
  const st = await stat(dir);
  if (!st.isDirectory()) throw Object.assign(new Error('the backup folder is not a folder'), { code: 'ENOTDIR' });
  await access(dir, constants.W_OK | constants.X_OK);
}

/** What a folder of photo copies is asked: a `put` that never overwrites, a `head` for the stored size and a `get`. */
export interface PhotoFiles {
  put(id: string, kind: string, bytes: Buffer): Promise<void>;
  head(id: string, kind: string): Promise<{ size: number } | null>;
  get(id: string, kind: string): Promise<Buffer | null>;
}

/**
 * The photo copies in a folder, `<dir>/<photo id>-<kind>`. Create-once like the bucket's If-None-Match: * (B2): written to <name>.<random>.partial, flushed to disk (fsync), then linked into place,
 * which fails when the name exists, so a final name always holds a complete file; the same bytes again are accepted and other bytes under the same name are refused (a fault, never an
 * overwrite). A crash leaves only a .partial file, which the dump job removes after an hour (backup-folder.mjs sweepPartials, which also looks in photos/).
 */
export function directoryPhotos(dir: string): PhotoFiles {
  const file = (id: string, kind: string) => path.join(dir, `${id}-${kind}`);
  const missing = (e: unknown): null => {
    if ((e as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    throw e;
  };
  return {
    async put(id, kind, bytes) {
      await mkdir(dir, { recursive: true });
      const target = file(id, kind);
      const tmp = `${target}.${randomUUID()}.partial`;
      const handle = await open(tmp, 'wx');
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(tmp, target);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const existing = await readFile(target);
        if (existing.length !== bytes.length || !existing.equals(bytes)) {
          throw new Error(`photo ${id}-${kind} already exists with different content (size or sha256); photos never change, nothing was overwritten`);
        }
      } finally {
        await unlink(tmp).catch(() => undefined);
      }
    },
    head: (id, kind) => stat(file(id, kind)).then((s) => ({ size: s.size }), missing),
    get: (id, kind) => readFile(file(id, kind)).catch(missing),
  };
}

export interface FolderStats {
  /** final files in the three sub-folders (not `.partial`, not a folder) */
  files: number;
  bytes: number;
  /** the free disk (statfs) of the volume; on a shared server it is the whole server's, so it is a figure to look at and not a budget (API34) */
  free_bytes: number | null;
  daily: number;
  monthly: number;
  photos: number;
}

/** The figures backup_runs.detail.folder holds: final files in the three sub-folders (not `.partial`), their total size, and the free disk (statfs). */
export async function folderStats(dir: string): Promise<FolderStats> {
  const counts = { daily: 0, monthly: 0, photos: 0 };
  let bytes = 0;
  for (const sub of SUBFOLDERS) {
    let entries;
    try {
      entries = await readdir(path.join(dir, sub), { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.endsWith('.partial')) continue;
      counts[sub] += 1;
      bytes += (await stat(path.join(dir, sub, entry.name))).size;
    }
  }
  let free: number | null = null;
  try {
    const fs = await statfs(dir);
    free = Number(fs.bavail) * Number(fs.bsize);
  } catch {
    free = null;
  }
  return { files: counts.daily + counts.monthly + counts.photos, bytes, free_bytes: free, daily: counts.daily, monthly: counts.monthly, photos: counts.photos };
}
