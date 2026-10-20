// B2, D25, I12 (RV3a-F1): THE NIGHTLY CHECK OF THE PHOTO COPIES. The photo copy of photoCopy.ts writes each photo once and remembers it in `sys_photo_copies`; before this file nothing ever looked at a
// copy again, so a copy that vanished from the backup folder (one file, or the whole photos/ folder: B2 names "the removal of the website" and the folder renamed when a domain is connected) was
// never found, never written again, and the owner's line went green again after seven days with the photo missing for good.
//
// What the check does, in the same phase and the same night, after the new photos have been copied:
//   1. EVERY recorded copy is looked at: does the file exist, and is its size the recorded one (one `stat`; the folder's own figures are worked out the same way every night).
//   2. A bounded, rolling SAMPLE of the copies is read and its sha256 compared with the recorded one: at least `minFiles` copies a night and `ceil(copies / cycleNights)`, never more than `maxBytes`
//      bytes a night, taken in the order of the primary key from where last night's sample ended. Every copy is therefore hashed within about a month (the cycle plus the night the cursor wraps).
//      The cursor (`next`) lives in `backup_runs.detail.verify` of the last night's row: no migration.
//   3. A MISSING copy is written again from the database's own bytes, after those bytes were checked against the sha256 and size recorded for the copy, through the same temp-file-then-link path as
//      a normal copy (`store.put`). Nothing is added to or deleted from `sys_photo_copies`: the row was always there. A copy whose photo has been removed since (a tombstone: the bytes are
//      gone from the database) cannot be written again and is no alarm: it is counted as `gone`.
//   4. A copy that EXISTS with another size, or whose bytes do not match, is DAMAGED, and is NEVER overwritten (B2: "different raises an alert and never overwrites"). The phase fails after
//      everything else was done, and the damaged copies are written down (`verify.damaged`, at most 50 of them, with the total) in the failed row of `backup_runs`; the next nights hash every
//      copy named there again whether or not the sample reaches it, so that moving the sample on never turns a damaged copy green. It is red (readHealth: `backup_photos_damaged`) until the file
//      is removed by hand: the next run finds it missing and writes it again.
//
// SLICES. The check is part of the tick's photo-copy phase, which stops starting new work after 25 seconds (I8). The check asks `shouldStop` before each copy it looks at; if it stops, the position
// (`after`) and the counters are kept in `detail.verify_state` of the row (which stays `running`), and the next tick goes on from there. The state is plain JSON.
import { createHash } from 'node:crypto';
import { withAutocommit } from '../db/autocommit.js';
import type { TxContext } from '../db/tx.js';
import { type PhotoKind, createDbPhotoStore } from '../photos/photoStore.js';
import type { PhotoFiles } from './backupFolder.js';

export const VERIFY_LIMITS = Object.freeze({
  /** Every copy is hashed within this many nights; the night the cursor wraps comes on top, so a full round is `cycleNights + 1` nights ("about a month"). */
  cycleNights: 27,
  /** At least this many copies are hashed a night (a small shop is checked in full). */
  minFiles: 20,
  /** Never more than this many bytes are read for hashing in a night (one copy is always read, so the sample moves on). The plan holds 3 GB of photos at most: 27 x 128 MiB is 3.4 GB. */
  maxBytes: 128 * 1024 * 1024,
  /** Rows of sys_photo_copies read at a time. */
  pageRows: 500,
  /** The damaged copies a row names; the total is always counted. */
  damagedKept: 50,
});

export interface VerifyLimits {
  cycleNights: number;
  minFiles: number;
  maxBytes: number;
}

export interface CopyKey {
  id: string;
  kind: string;
}

export type DamageReason =
  /** the file has another size than the one recorded */
  | 'size'
  /** the file has the recorded size but its bytes do not match the recorded sha256 */
  | 'sha256'
  /** the file could not be looked at or read (permissions, the disk) */
  | 'unreadable'
  /** the copy is missing, and the database's bytes do not match the sha256 recorded for the copy: nothing is written */
  | 'database_bytes'
  /** the copy is missing, the database's bytes are right, and the file could not be written (or another file appeared under the name meanwhile) */
  | 'not_written';

export interface DamagedCopy extends CopyKey {
  reason: DamageReason;
  note?: string;
}

/** Where the check is, counters included. Kept in the `running` row of the phase between two slices. */
export interface VerifyState {
  /** the last copy looked at (the position in the primary-key order); null = from the start */
  after: CopyKey | null;
  /** the files of tonight's sample */
  quota: number;
  /** the sample has begun (the copy after the last one of the night before has been reached) */
  sampling: boolean;
  /** the sample is complete (its files or bytes are used up) */
  window_closed: boolean;
  sample_files: number;
  sample_bytes: number;
  last_hashed: CopyKey | null;
  checked: number;
  missing: number;
  repaired: number;
  repaired_bytes: number;
  gone: number;
  hashed: number;
  hashed_bytes: number;
  damaged_total: number;
  damaged: DamagedCopy[];
}

/** What a finished check writes into `backup_runs.detail.verify` and into the job's `detail`. `next` is where tomorrow's sample begins (after that copy); null = from the start. */
export interface VerifySummary {
  quota: number;
  checked: number;
  missing: number;
  repaired: number;
  repaired_bytes: number;
  gone: number;
  hashed: number;
  hashed_bytes: number;
  damaged_total: number;
  damaged: DamagedCopy[];
  next: CopyKey | null;
}

export interface VerifyMemory {
  sampleFrom: CopyKey | null;
  known: CopyKey[];
}

interface CopyRow {
  id: string;
  kind: string;
  sha: string;
  size: number | string;
}

const COUNT_SQL = 'SELECT COUNT(*) AS n FROM sys_photo_copies';
const PAGE_SQL = 'SELECT p.photo_id AS id, p.kind AS kind, HEX(p.sha256) AS sha, p.size AS size FROM sys_photo_copies p ORDER BY p.photo_id, p.kind LIMIT ?';
// the keys are compared as the UUID type compares them (server side), never as text: the type has an order of its own
const PAGE_AFTER_SQL =
  'SELECT p.photo_id AS id, p.kind AS kind, HEX(p.sha256) AS sha, p.size AS size FROM sys_photo_copies p WHERE p.photo_id > ? OR (p.photo_id = ? AND p.kind > ?) ORDER BY p.photo_id, p.kind LIMIT ?';
const MEMORY_SQL = "SELECT detail FROM backup_runs WHERE kind = 'photo_copy' AND JSON_CONTAINS_PATH(detail, 'one', '$.verify') ORDER BY id DESC LIMIT 1";

const sameKey = (a: CopyKey, b: CopyKey): boolean => a.id === b.id && a.kind === b.kind;
const keyOf = (k: CopyKey): string => `${k.id}/${k.kind}`;
const isKey = (v: unknown): v is CopyKey => typeof v === 'object' && v !== null && typeof (v as CopyKey).id === 'string' && typeof (v as CopyKey).kind === 'string';
const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

export function freshState(quota: number, sampleFrom: CopyKey | null): VerifyState {
  return {
    after: null,
    quota,
    sampling: sampleFrom === null,
    window_closed: false,
    sample_files: 0,
    sample_bytes: 0,
    last_hashed: null,
    checked: 0,
    missing: 0,
    repaired: 0,
    repaired_bytes: 0,
    gone: 0,
    hashed: 0,
    hashed_bytes: 0,
    damaged_total: 0,
    damaged: [],
  };
}

/** A state read back from a `running` row; null for anything that is not one (a row of another shape starts the check again, which is harmless: a repair already made is not repeated). */
export function readState(detail: unknown): VerifyState | null {
  const s = (detail as { verify_state?: unknown } | null | undefined)?.verify_state as Partial<VerifyState> | undefined;
  if (!s || typeof s !== 'object') return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const base = freshState(Math.max(1, n(s.quota)), null);
  return {
    ...base,
    after: isKey(s.after) ? { id: s.after.id, kind: s.after.kind } : null,
    sampling: s.sampling === true,
    window_closed: s.window_closed === true,
    sample_files: n(s.sample_files),
    sample_bytes: n(s.sample_bytes),
    last_hashed: isKey(s.last_hashed) ? { id: s.last_hashed.id, kind: s.last_hashed.kind } : null,
    checked: n(s.checked),
    missing: n(s.missing),
    repaired: n(s.repaired),
    repaired_bytes: n(s.repaired_bytes),
    gone: n(s.gone),
    hashed: n(s.hashed),
    hashed_bytes: n(s.hashed_bytes),
    damaged_total: n(s.damaged_total),
    damaged: Array.isArray(s.damaged) ? (s.damaged.filter((d) => isKey(d) && typeof (d as DamagedCopy).reason === 'string') as DamagedCopy[]) : [],
  };
}

export function summarize(state: VerifyState): VerifySummary {
  return {
    quota: state.quota,
    checked: state.checked,
    missing: state.missing,
    repaired: state.repaired,
    repaired_bytes: state.repaired_bytes,
    gone: state.gone,
    hashed: state.hashed,
    hashed_bytes: state.hashed_bytes,
    damaged_total: state.damaged_total,
    damaged: state.damaged,
    // the sample ended because its files or bytes were used up: tomorrow goes on after the last copy hashed; it ran off the end of the copies: tomorrow starts again from the first
    next: state.window_closed ? state.last_hashed : null,
  };
}

/** Where last night's sample ended, and the copies the earlier nights found damaged (they are looked at again until they are fixed): from the newest `photo_copy` row of `backup_runs` that has a `verify`. */
export async function readMemory(ctx: TxContext): Promise<VerifyMemory> {
  const rows = await withAutocommit(ctx, (db) => db.rows<{ detail: unknown }>(MEMORY_SQL));
  const verify = verifyOf(rows[0]?.detail);
  const next = isKey(verify.next) ? { id: verify.next.id, kind: verify.next.kind } : null;
  const known = Array.isArray(verify.damaged) ? (verify.damaged as unknown[]).filter(isKey).map((k) => ({ id: k.id, kind: k.kind })) : [];
  return { sampleFrom: next, known };
}

/** The `verify` object of a backup_runs.detail (text or already parsed); an empty object when there is none. */
function verifyOf(raw: unknown): { next?: unknown; damaged?: unknown } {
  try {
    const detail = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { verify?: { next?: unknown; damaged?: unknown } } | null | undefined;
    return detail?.verify && typeof detail.verify === 'object' ? detail.verify : {};
  } catch {
    return {};
  }
}

export interface VerifyInput {
  limits: VerifyLimits;
  memory: VerifyMemory;
  /** the state of an earlier slice of the same night, or null for the first */
  carried: VerifyState | null;
  /** asked before each copy; true ends the slice (the 25 seconds, or the call's signal) */
  shouldStop: () => boolean;
}

export interface VerifyResult {
  /** every copy was looked at; false: the slice stopped and `state` says where */
  done: boolean;
  state: VerifyState;
}

/** The files of tonight's sample: at least `minFiles`, and enough to hash every copy within `cycleNights` nights. */
export const sampleSize = (copies: number, limits: VerifyLimits): number => Math.max(limits.minFiles, Math.ceil(copies / limits.cycleNights));

export async function verifyCopies(contexts: () => TxContext, store: PhotoFiles, input: VerifyInput): Promise<VerifyResult> {
  const { limits, memory } = input;
  let state = input.carried;
  if (!state) {
    const [count] = await withAutocommit(contexts(), (db) => db.rows<{ n: number | string }>(COUNT_SQL));
    state = freshState(sampleSize(Number(count.n), limits), memory.sampleFrom);
  }
  const s = state;
  const known = new Set(memory.known.map(keyOf));

  const damage = (row: CopyRow, reason: DamageReason, note?: string): void => {
    s.damaged_total += 1;
    if (s.damaged.length < VERIFY_LIMITS.damagedKept) s.damaged.push({ id: row.id, kind: row.kind, reason, ...(note ? { note: note.slice(0, 200) } : {}) });
  };

  /** A missing copy: written again from the database's bytes if those are the bytes the copy was made from; never from anything else. */
  const repair = async (row: CopyRow, size: number): Promise<void> => {
    s.missing += 1;
    const stored = await createDbPhotoStore(contexts()).get(row.id, row.kind as PhotoKind);
    if (!stored || !stored.bytes) {
      s.gone += 1; // a tombstone (P3): the owner removed the photo, the database no longer holds its bytes, and a restore treats it as removed
      return;
    }
    if (stored.bytes.length !== size || sha256Hex(stored.bytes) !== row.sha.toLowerCase()) {
      damage(row, 'database_bytes');
      return;
    }
    try {
      await store.put(row.id, row.kind, stored.bytes); // create-once: temp file, fsync, link; other bytes under the name are refused, never overwritten
      const head = await store.head(row.id, row.kind);
      if (!head || Number(head.size) !== stored.bytes.length) {
        damage(row, 'not_written', `the folder holds ${head ? head.size : 'nothing'} after the write`);
        return;
      }
    } catch (e) {
      damage(row, 'not_written', (e as Error).message);
      return;
    }
    s.repaired += 1;
    s.repaired_bytes += stored.bytes.length;
  };

  const examine = async (row: CopyRow): Promise<void> => {
    const size = Number(row.size);
    const key: CopyKey = { id: row.id, kind: row.kind };
    s.checked += 1;
    const forced = known.has(keyOf(key));
    const inSample = s.sampling && !s.window_closed;
    // the copy after the last one of the night before is where the sample begins: this copy itself was hashed then
    const startsAfterThis = !s.sampling && memory.sampleFrom !== null && sameKey(key, memory.sampleFrom);

    let head: { size: number } | null;
    try {
      head = await store.head(row.id, row.kind);
    } catch (e) {
      damage(row, 'unreadable', (e as NodeJS.ErrnoException).code ?? (e as Error).message);
      if (startsAfterThis) s.sampling = true;
      return;
    }
    if (head === null) {
      await repair(row, size);
    } else if (Number(head.size) !== size) {
      damage(row, 'size', `${head.size} bytes in the folder, ${size} recorded`);
    } else if (inSample || forced) {
      // the sample is bounded by files and by bytes; one copy is always read, so that the sample moves on
      const fits = s.sample_files < s.quota && (s.sample_files === 0 || s.sample_bytes + size <= limits.maxBytes);
      if (inSample && !fits) s.window_closed = true;
      if (forced || (inSample && fits)) {
        let bytes: Buffer | null;
        try {
          bytes = await store.get(row.id, row.kind);
        } catch (e) {
          damage(row, 'unreadable', (e as NodeJS.ErrnoException).code ?? (e as Error).message);
          if (startsAfterThis) s.sampling = true;
          return;
        }
        if (bytes === null) {
          await repair(row, size); // it vanished between the look and the read
        } else {
          s.hashed += 1;
          s.hashed_bytes += bytes.length;
          if (inSample && fits) {
            s.sample_files += 1;
            s.sample_bytes += bytes.length;
            s.last_hashed = key;
            if (s.sample_files >= s.quota) s.window_closed = true;
          }
          if (bytes.length !== size || sha256Hex(bytes) !== row.sha.toLowerCase()) damage(row, 'sha256');
        }
      }
    }
    if (startsAfterThis) s.sampling = true;
  };

  for (;;) {
    const page = await withAutocommit(contexts(), (db) =>
      s.after
        ? db.rows<CopyRow>(PAGE_AFTER_SQL, [s.after.id, s.after.id, s.after.kind, VERIFY_LIMITS.pageRows])
        : db.rows<CopyRow>(PAGE_SQL, [VERIFY_LIMITS.pageRows]),
    );
    for (const row of page) {
      if (input.shouldStop()) return { done: false, state: s };
      await examine(row);
      s.after = { id: row.id, kind: row.kind };
    }
    if (page.length < VERIFY_LIMITS.pageRows) break;
  }
  return { done: true, state: s };
}
