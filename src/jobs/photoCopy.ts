// I8, B2, D25, D17: THE PHOTO COPY, the fourth phase of the tick. The photos are in the database (P3: a photo never changes, its id is its content) and the nightly export leaves their bytes out, so
// each photo object (`full` and `thumb`) that has not been copied yet is written ONCE into `<JV_BACKUP_DIR>/photos/<photo id>-<kind>` and recorded in `sys_photo_copies` (D25), only after a
// `stat` of the file has confirmed the stored size. A removed photo (a tombstone) is not copied, and a copy is never overwritten.
//
// SLICES. Each photo is independent, so the work goes in slices: "a slice stops starting new work after 25 seconds, so that 25 seconds plus one statement of up to 20 stays under the tick's own
// handler timer of 50 seconds; it records where it stopped in `detail` and the next tick goes on". The time is the API's clock (S5), measured from the start of the phase; the call's signal
// (the handler timer fired, or the client went) stops the slice too. A slice that stopped early leaves its row `running` with the end time of the slice, and the next tick continues AT ONCE (the
// state of the work is in the database, not in `detail`: what is not in `sys_photo_copies` is still to do; `detail` only keeps the totals for the date).
//
// COMPLETE, AND ONLY THEN `ok`. The phase is complete when the list of photos still to copy was read to its end, nothing was left because of the time or the row limit, and every photo was copied.
// Then, and only then, the row is `ok` and ONE `backup_runs` row of kind photo_copy with ok true is written: that row is the second heartbeat of I12, so it is written every night, also when
// there was nothing to copy (a quiet month must not turn the line red). A slice that stopped early writes no such row (D17: never an `ok` for a partial slice).
//
// A FAILURE IS LOUD. A photo that cannot be copied (the disk, a damaged row) does not stop the others: the slice goes on, and the phase then FAILS with the count (PhotoCopyError), so the tick
// answers an error, the row is `failed` and the next tick tries again. The same goes for a folder that is not set, not there, not a folder or not writable: it is never read as "nothing to copy"
// and it is never made here. A failure writes ONE backup_runs row with ok false for the business date (D17), not one for every hourly retry.
//
// photoCopy.ts is also the TypeScript twin of `copyPhotosOnce` in scripts/backup.mjs (MB03): the same list, the same checks and the same words in a fault (the bytes of one photo are read through
// the PhotoStore of API17, the one place in src/ that selects them: T-F10); tests/api/backup-twins.test.ts
// keeps the two equal on a real database. What the twin adds is the way to stop (`shouldStop`, asked before each photo) and a statement context for each photo: a TxContext keeps the 12 seconds of
// S12 from the moment it is made, and a slice runs longer than that.
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { withAutocommit } from '../db/autocommit.js';
import type { TxContext } from '../db/tx.js';
import { type PhotoKind, createDbPhotoStore } from '../photos/photoStore.js';
import { type PhotoFiles, assertFolderUsable, directoryPhotos, folderStats, resolveBackupDir } from './backupFolder.js';
import { recordBackupRun } from './backupRuns.js';
import { JOB_LIMITS } from './schedule.js';
import type { Phase, PhaseContext } from './types.js';

const TODO_SQL =
  'SELECT d.id AS id, d.kind AS kind, HEX(d.sha256) AS sha, d.byte_size AS size FROM design_photos d LEFT JOIN sys_photo_copies p ON p.photo_id = d.id AND p.kind = d.kind WHERE d.removed_at IS NULL AND p.photo_id IS NULL ORDER BY d.created_at, d.id, d.kind LIMIT ?';
const RECORD_SQL = 'INSERT INTO sys_photo_copies (photo_id, kind, sha256, size) VALUES (?, ?, UNHEX(?), ?) ON DUPLICATE KEY UPDATE photo_id = photo_id';

/** The words of a photo that was removed (a tombstone, P3) between the list and its bytes. The script says them too; the phase does not count them as a fault. */
const REMOVED_WHILE_COPYING = 'the photo was removed while the copy ran';

interface Pending {
  id: string;
  kind: string;
  sha: string;
  size: number | string;
}

export interface CopyFailure {
  id: string;
  kind: string;
  error: string;
}

export interface CopyResult {
  copied: number;
  bytes: number;
  failed: CopyFailure[];
  /** `shouldStop` said so: photos were left for the next slice */
  stopped: boolean;
  /** the list was cut by the row limit: there may be more to copy */
  more: boolean;
}

export interface CopyOptions {
  /** how many photos to take from the list in one go (default: all of them, as copyPhotosOnce) */
  limit?: number;
  /** asked before each photo; true ends the slice */
  shouldStop?: () => boolean;
}

/**
 * Copies the photos that have no row in sys_photo_copies yet, oldest first, into `store`. `contexts` makes a statement context: it is called for every photo, because a context's deadline
 * runs from the moment it is made. A photo that fails is written down in `failed` and the others go on.
 */
export async function copyPhotos(contexts: () => TxContext, store: PhotoFiles, options: CopyOptions = {}): Promise<CopyResult> {
  const limit = Number.isInteger(options.limit) && (options.limit as number) > 0 ? (options.limit as number) : 1_000_000;
  const todo = await withAutocommit(contexts(), (db) => db.rows<Pending>(TODO_SQL, [limit]));
  const result: CopyResult = { copied: 0, bytes: 0, failed: [], stopped: false, more: todo.length >= limit };
  for (const p of todo) {
    if (options.shouldStop?.()) {
      result.stopped = true;
      break;
    }
    try {
      // the bytes are read through the PhotoStore, the one place that selects them (D26, P7, T-F10): one row by its primary key, null for a photo that was removed meanwhile
      const row = await createDbPhotoStore(contexts()).get(p.id, p.kind as PhotoKind);
      if (!row || !row.bytes) throw new Error(REMOVED_WHILE_COPYING);
      const actual = createHash('sha256').update(row.bytes).digest('hex').toUpperCase();
      if (actual !== p.sha.toUpperCase() || row.bytes.length !== Number(p.size)) throw new Error('the stored bytes do not match the recorded sha256 and size');
      await store.put(p.id, p.kind, row.bytes);
      // a copy is remembered only after the folder confirms the stored size (a stat)
      const head = await store.head(p.id, p.kind);
      if (!head) throw new Error('the object is not in the bucket after the upload');
      if (Number(head.size) !== row.bytes.length) throw new Error(`the bucket holds ${head.size} bytes, the photo has ${row.bytes.length}: size mismatch`);
      await withAutocommit(contexts(), (db) => db.run(RECORD_SQL, [p.id, p.kind, p.sha, row.bytes.length]));
      result.copied += 1;
      result.bytes += row.bytes.length;
    } catch (e) {
      result.failed.push({ id: p.id, kind: p.kind, error: (e as Error).message });
    }
  }
  return result;
}

// ------------------------------------------------------------------ the phase

/** The phase failed because photos could not be copied, after the others were. `code` is what a failed run writes into its `detail`. */
export class PhotoCopyError extends Error {
  readonly code = 'JV_PHOTO_COPY';
  constructor(message: string) {
    super(message);
    this.name = 'PhotoCopyError';
  }
}

export interface PhotoCopyOptions {
  /** The store over `<JV_BACKUP_DIR>/photos` (default: the folder's own, directoryPhotos). A test seam. */
  store?: (photosDir: string) => PhotoFiles;
  /** The length of a slice in milliseconds (default: 25 seconds, I8). A test seam. */
  sliceMs?: number;
  /** Photos taken from the list in one slice (default JOB_LIMITS.photoRowsPerSlice). A test seam. */
  limit?: number;
}

interface Totals {
  slices: number;
  copied: number;
  bytes: number;
}

/** Where the work of this date had got to: the totals of the slices before, kept in `detail` of a row that stays `running` between two ticks. */
function totalsBefore(previous: PhaseContext['previous']): Totals {
  const detail = previous?.status === 'running' && previous.detail && typeof previous.detail === 'object' ? (previous.detail as Partial<Totals>) : {};
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  return { slices: n(detail.slices), copied: n(detail.copied), bytes: n(detail.bytes) };
}

export function createPhotoCopyPhase(options: PhotoCopyOptions = {}): Phase {
  const sliceMicros = BigInt(Math.round((options.sliceMs ?? JOB_LIMITS.photoSliceSeconds * 1000) * 1000));
  const limit = options.limit ?? JOB_LIMITS.photoRowsPerSlice;
  const makeStore = options.store ?? directoryPhotos;

  /** D17: a failed phase is a row with ok false, once for the business date (a retry of a failed row does not write another). */
  async function recordFailure(ctx: PhaseContext, detail: Record<string, unknown>): Promise<void> {
    if (ctx.previous?.status === 'failed') return;
    try {
      await recordBackupRun(ctx.txContext(), { kind: 'photo_copy', ok: false, detail: { date: ctx.runDate, ...detail }, ranAt: ctx.app.clock.read().timestamp });
    } catch {
      // the row could not be written (the database is the likely cause): the failed run of the tick says what happened
    }
  }

  return {
    job: 'photo_copy',
    due: 'nightly',
    async run(ctx) {
      const before = totalsBefore(ctx.previous);
      let dir: string;
      let result: CopyResult;
      try {
        dir = resolveBackupDir(ctx.app.config.backupDir);
        await assertFolderUsable(dir);
        const photosDir = path.join(dir, 'photos');
        await mkdir(photosDir).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== 'EEXIST') throw e; // the folder itself is there (checked above); only photos/ may be new
        });
        const clock = ctx.app.clock;
        const start = clock.read().micros;
        const shouldStop = () => ctx.signal.aborted || clock.read().micros - start >= sliceMicros;
        result = await copyPhotos(ctx.txContext, makeStore(photosDir), { limit, shouldStop });
      } catch (e) {
        const err = e as Error & { code?: string };
        await recordFailure(ctx, { error: { name: err.name, code: err.code ?? null, message: String(err.message).slice(0, 300) } });
        throw e;
      }

      // A photo the owner removed while the slice ran is not a fault: it is not in the list any more (a tombstone is never copied) and the night goes on.
      const faults = result.failed.filter((f) => f.error !== REMOVED_WHILE_COPYING);
      if (faults.length > 0) {
        await recordFailure(ctx, { failed: faults.length, copied: result.copied, first_error: faults[0].error.slice(0, 300) });
        throw new PhotoCopyError(`${faults.length} of ${result.copied + faults.length} photo objects could not be copied (the first: ${faults[0].error.slice(0, 200)})`);
      }

      const totals: Totals = { slices: before.slices + 1, copied: before.copied + result.copied, bytes: before.bytes + result.bytes };
      const facts = { copied: result.copied, bytes: result.bytes, slices: totals.slices };
      if (result.stopped || result.more) {
        // the slice ended early: where it stopped is in `sys_photo_copies`; the totals are here. No heartbeat: never an `ok` for a partial slice (D17).
        return { complete: false, detail: { date: ctx.runDate, ...totals, stopped: result.stopped ? (ctx.signal.aborted ? 'signal' : 'time') : 'limit' }, facts };
      }

      // complete: the list was read to its end and every photo is in the folder. The heartbeat of I12, with the folder as it is now (the dashboard compares its file count from night to night).
      const folder = await folderStats(dir);
      const run = await recordBackupRun(ctx.txContext(), {
        kind: 'photo_copy',
        ok: true,
        bytes: totals.bytes,
        detail: { date: ctx.runDate, ...totals, failed: 0, folder },
        ranAt: ctx.app.clock.read().timestamp,
      });
      return { complete: true, detail: { date: ctx.runDate, ...totals, backup_run_id: run.id }, facts: { ...facts, backup_run_id: run.id } };
    },
  };
}

/** The application's photo copy. */
export const photoCopyPhase: Phase = createPhotoCopyPhase();
