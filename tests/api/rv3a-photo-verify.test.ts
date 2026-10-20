import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatTimestamp } from '../../src/clock';
import { type PhotoFiles, directoryPhotos } from '../../src/jobs/backupFolder';
import { createPhotoCopyPhase } from '../../src/jobs/photoCopy';
import { readHealth } from '../../src/reads/health';
import { type PhotoObject, type TickWorld, addPhotoObjects, at, backupRuns, copiedRows, tickWorld } from './tick-support';

// RV3a-F1 (implementation review 3, finding F1; B2, I12, D25): a photo copy that VANISHES from the backup folder (one file, or the whole photos/ folder), or is REPLACED by other bytes, used to turn the
// owner's line red for seven days and then green again, with the photo missing for good: the photo copy only copies photos that have no row in sys_photo_copies. The nightly photo-copy phase now
// looks at EVERY recorded copy (does the file exist, is its size the recorded one) and hashes a bounded, rolling sample of them (every copy within about a month); a missing copy is written again
// from the database's own bytes (checked against the recorded sha256 first), the repair is counted and shown (amber, seven days); a copy that exists with other bytes or another size is NEVER
// overwritten (B2): the phase fails and the line is red until the damaged file is taken away by hand. The story of each describe is told in order on a clock that only moves forward: night n is
// 02:00 in Asia/Kolkata on 18 Oct + n, and `set(w, night(n, 1))` is one hour into it (the next hourly tick of the same business date).

const DAY_MS = 86_400_000;
const night = (n: number, hours = 0): string => new Date(Date.parse('2026-10-17T20:30:00Z') + n * DAY_MS + hours * 3_600_000).toISOString().slice(0, 19) + 'Z';
const set = (w: TickWorld, iso: string) => {
  w.time.time.micros = at(iso);
};
const nameOf = (p: { id: string; kind: string }) => `${p.id}-${p.kind}`;
const photosDir = (w: TickWorld) => path.join(w.backupDir!, 'photos');
const photoNames = (w: TickWorld) => readdir(photosDir(w)).then((n) => n.filter((x) => !x.endsWith('.partial')).sort());

interface Log {
  puts: string[];
  heads: string[];
  gets: string[];
  /** microseconds that a put costs on the test's clock (a slice of 25 seconds takes no real time) */
  putCost: bigint;
}
const newLog = (): Log => ({ puts: [], heads: [], gets: [], putCost: 0n });
const clear = (log: Log) => {
  log.puts.length = 0;
  log.heads.length = 0;
  log.gets.length = 0;
};

/** The folder store of the phase, with a record of what it was asked (and a price on the clock for a put). */
function recordingStore(log: Log, w: () => TickWorld) {
  return (dir: string): PhotoFiles => {
    const real = directoryPhotos(dir);
    return {
      async put(id, kind, bytes) {
        log.puts.push(`${id}-${kind}`);
        await real.put(id, kind, bytes);
        w().time.time.micros += log.putCost;
      },
      async head(id, kind) {
        log.heads.push(`${id}-${kind}`);
        return real.head(id, kind);
      },
      async get(id, kind) {
        log.gets.push(`${id}-${kind}`);
        return real.get(id, kind);
      },
    };
  };
}

const outcome = (res: { json(): unknown }) => ((res.json() as any).phases as { job: string; outcome: string }[]).find((p) => p.job === 'photo_copy')?.outcome;
const lastRun = async (w: TickWorld) => (await w.runs('photo_copy')).at(-1)!;

/** The owner's line at `iso`, with the check and the export made good at that instant, so that only the photo copy's own reasons are left to read. */
async function line(w: TickWorld, iso: string) {
  const now = at(iso);
  await w.sql.query('INSERT INTO check_runs (ran_at, ok, details) VALUES (?, 1, ?)', [formatTimestamp(now - 3_600_000_000n), JSON.stringify({ invariants: [] })]);
  await w.sql.query("INSERT INTO backup_runs (ran_at, kind, ok, bytes, detail) VALUES (?, 'db_dump', 1, 1000, '{}')", [formatTimestamp(now - 3_600_000_000n)]);
  return readHealth(w.sql, { now: formatTimestamp(now), sizeBytes: 123_456 });
}

describe('RV3a-F1 a copy that vanishes from the backup folder is found by the nightly check and copied again, and the line says so', () => {
  let w: TickWorld;
  const log = newLog();
  let objects: PhotoObject[] = [];
  beforeAll(async () => {
    w = await tickWorld('rv3af1a', { phases: [createPhotoCopyPhase({ store: recordingStore(log, () => w) })] });
    objects = await addPhotoObjects(w.sql, 6, { kinds: ['full', 'thumb'] });
  }, 120_000);
  afterAll(async () => {
    await w?.close();
  });

  it('night 0: the six photo objects are copied, as before', async () => {
    set(w, night(0));
    const res = await w.tick();
    expect(res.statusCode, res.body).toBe(200);
    expect(outcome(res)).toBe('ran');
    expect(await photoNames(w)).toEqual(objects.map(nameOf).sort());
    expect((await copiedRows(w.sql)).length).toBe(6);
  });

  it('RV3a-F1 negative control: a healthy folder is checked and left alone (nothing is written again, nothing is repaired, no new reason on the line)', async () => {
    clear(log);
    set(w, night(1));
    const res = await w.tick();
    expect(res.statusCode, res.body).toBe(200);
    expect(outcome(res)).toBe('ran');
    expect(log.puts, 'a photo that is there with the right bytes is not written again').toEqual([]);
    expect(new Set(log.heads).size, 'every recorded copy is looked at').toBe(6);
    const run = await lastRun(w);
    expect(run.status).toBe('ok');
    expect(run.detail).toMatchObject({ repaired: 0, verify: { checked: 6, missing: 0, repaired: 0, damaged_total: 0 } });
    const h = await line(w, night(1, 1));
    expect(h.reasons).toEqual([]);
    expect(h.level).toBe('green');
    expect(h.photo_files).toEqual({ repaired: 0, repaired_at: null, damaged: 0, damaged_at: null });
  });

  it('RV3a-F1 one copy deleted from the folder: the next night writes it again from the database, the table of copies is untouched, the repair is counted in the job and shown amber', async () => {
    const victim = objects[2];
    const before = await copiedRows(w.sql);
    await rm(path.join(photosDir(w), nameOf(victim)));
    clear(log);
    set(w, night(2));
    const res = await w.tick();
    expect(res.statusCode, res.body).toBe(200);
    expect(outcome(res)).toBe('ran');
    expect(log.puts, 'only the missing one is written').toEqual([nameOf(victim)]);
    expect(existsSync(path.join(photosDir(w), nameOf(victim))), 'THE FALSE GREEN: the copy is gone for good').toBe(true);
    expect((await readFile(path.join(photosDir(w), nameOf(victim)))).equals(victim.bytes)).toBe(true);
    expect(await copiedRows(w.sql), 'sys_photo_copies is not touched (no delete, no new row)').toEqual(before);
    expect((await photoNames(w)).some((n) => n.endsWith('.partial'))).toBe(false);

    const run = await lastRun(w);
    expect(run.detail).toMatchObject({ repaired: 1, verify: { checked: 6, missing: 1, repaired: 1, damaged_total: 0 } });
    const okRow = (await backupRuns(w.sql, 'photo_copy')).at(-1)!;
    expect(okRow).toMatchObject({ ok: 1 });
    expect(okRow.detail.verify).toMatchObject({ repaired: 1, repaired_bytes: victim.bytes.length });
    expect(okRow.detail.folder.photos, 'the folder count did not fall').toBe(6);

    const h = await line(w, night(2, 1));
    expect(h.reasons).toEqual(['backup_photos_repaired']);
    expect(h.level).toBe('amber');
    expect(h.photo_files).toMatchObject({ repaired: 1, damaged: 0 });
  });

  it('RV3a-F1 the whole photos/ folder removed (its parent is fine): every copy is written again the same night, 6 repaired', async () => {
    await rm(photosDir(w), { recursive: true, force: true });
    clear(log);
    set(w, night(3));
    const res = await w.tick();
    expect(res.statusCode, res.body).toBe(200);
    expect(outcome(res)).toBe('ran');
    expect(await photoNames(w)).toEqual(objects.map(nameOf).sort());
    for (const p of objects) expect((await readFile(path.join(photosDir(w), nameOf(p)))).equals(p.bytes), nameOf(p)).toBe(true);
    expect((await lastRun(w)).detail).toMatchObject({ repaired: 6, verify: { missing: 6, repaired: 6 } });
    const h = await line(w, night(3, 1));
    expect(h.reasons).toEqual(['backup_photos_repaired']);
    expect(h.photo_files.repaired).toBe(7); // 1 on night 2 and 6 on night 3, both inside the seven days
  });

  it('RV3a-F1 a copy of a photo that was removed since (a tombstone: its bytes are gone from the database) is not written again and is no alarm', async () => {
    const [extra] = await addPhotoObjects(w.sql, 1, { from: 50 });
    set(w, night(4));
    expect(outcome(await w.tick())).toBe('ran');
    expect(existsSync(path.join(photosDir(w), nameOf(extra)))).toBe(true);
    await w.sql.query('UPDATE design_photos SET removed_at = ?, bytes = NULL WHERE id = ?', ['2026-10-22 00:00:00.000000', extra.id]);
    await rm(path.join(photosDir(w), nameOf(extra)));
    clear(log);
    set(w, night(5));
    const res = await w.tick();
    expect(res.statusCode, res.body).toBe(200);
    expect(log.puts, 'there is nothing to copy it from').toEqual([]);
    expect(existsSync(path.join(photosDir(w), nameOf(extra)))).toBe(false);
    expect((await lastRun(w)).detail).toMatchObject({ repaired: 0, verify: { missing: 1, gone: 1, repaired: 0, damaged_total: 0 } });
    const h = await line(w, night(5, 1));
    expect(h.reasons).not.toContain('backup_photos_damaged');
    expect(h.photo_files, 'no new repair on night 5: the 7 of nights 2 and 3 are all there is').toMatchObject({ repaired: 7, damaged: 0 });
  });

  it('RV3a-F1 the repair stays on the line for the same seven days as a fall of the file count, then it is history (the last story of this world: the reads below put rows in the future)', async () => {
    // night 2 repaired one copy and night 3 six: six days after night 3 both are inside the seven days, eight days after neither is
    expect((await line(w, night(3, 24 * 6))).reasons).toContain('backup_photos_repaired');
    expect((await line(w, night(3, 24 * 8))).reasons).not.toContain('backup_photos_repaired');
  });
});

describe('RV3a-F1 a copy that exists with other bytes or another size is never overwritten: the phase fails and the line is red until it is taken away by hand', () => {
  let w: TickWorld;
  const log = newLog();
  let objects: PhotoObject[] = [];
  // one copy is hashed a night and the cycle is six nights: the sample reaches the damaged file on its own turn only
  beforeAll(async () => {
    w = await tickWorld('rv3af1b', { phases: [createPhotoCopyPhase({ store: recordingStore(log, () => w), verify: { minFiles: 1, cycleNights: 6, maxBytes: 10_000_000 } })] });
    objects = await addPhotoObjects(w.sql, 6, { kinds: ['full'] });
  }, 120_000);
  afterAll(async () => {
    await w?.close();
  });

  let nextNight = 1;

  it('night 0: six copies; then one is replaced by other bytes of the same size', async () => {
    set(w, night(0));
    expect(outcome(await w.tick())).toBe('ran');
    const f = path.join(photosDir(w), nameOf(objects[4]));
    await writeFile(f, randomBytes(objects[4].bytes.length));
  });

  it('RV3a-F1 within a full cycle of the sample the damaged copy is found: the tick answers an error, the foreign bytes are still there, one failed row says which copy and why', async () => {
    const foreign = await readFile(path.join(photosDir(w), nameOf(objects[4])));
    let found = false;
    for (; nextNight <= 7 && !found; nextNight++) {
      set(w, night(nextNight));
      const res = await w.tick();
      if (res.statusCode === 500) {
        found = true;
      }
    }
    expect(found, 'seven nights are more than the cycle of six: THE FALSE GREEN would pass them all').toBe(true);
    expect((await readFile(path.join(photosDir(w), nameOf(objects[4])))).equals(foreign), 'never overwritten (B2)').toBe(true);
    const run = await lastRun(w);
    expect(run.status).toBe('failed');
    const failed = (await backupRuns(w.sql, 'photo_copy')).at(-1)!;
    expect(failed).toMatchObject({ ok: 0 });
    expect(failed.detail.verify).toMatchObject({ damaged_total: 1, damaged: [{ id: objects[4].id, kind: 'full', reason: 'sha256' }] });
    const h = await line(w, night(nextNight - 1, 1));
    expect(h.reasons).toContain('backup_photos_damaged');
    expect(h.level).toBe('red');
    expect(h.photo_files).toMatchObject({ damaged: 1 });
  });

  it('RV3a-F1 and it stays red every night after, through more than a whole cycle, although the sample has moved on (the damaged copy is looked at again until it is fixed)', async () => {
    for (let i = 0; i < 7; i++) {
      clear(log);
      set(w, night(nextNight));
      const res = await w.tick();
      expect(res.statusCode, `night ${nextNight}`).toBe(500);
      expect(log.gets, `night ${nextNight}: the known damaged copy is hashed again`).toContain(nameOf(objects[4]));
      expect(log.puts, 'nothing is written over it').not.toContain(nameOf(objects[4]));
      expect((await line(w, night(nextNight, 1))).reasons, `night ${nextNight}`).toContain('backup_photos_damaged');
      nextNight++;
    }
    expect(log.gets.length, 'the sample is still bounded: the known copy and one more').toBeLessThanOrEqual(2);
  });

  it('RV3a-F1 the damaged file is removed by hand: the next tick writes the right bytes, the phase ends ok, the red reason is gone and the repair is shown', async () => {
    await rm(path.join(photosDir(w), nameOf(objects[4])));
    set(w, night(nextNight - 1, 2));
    const res = await w.tick();
    expect(res.statusCode, res.body).toBe(200);
    expect((await readFile(path.join(photosDir(w), nameOf(objects[4])))).equals(objects[4].bytes)).toBe(true);
    const h = await line(w, night(nextNight - 1, 3));
    expect(h.reasons).not.toContain('backup_photos_damaged');
    expect(h.reasons).toContain('backup_photos_repaired');
    expect(h.photo_files.damaged).toBe(0);
    expect(((await backupRuns(w.sql, 'photo_copy')).at(-1)!.detail.verify).damaged_total).toBe(0);
  });

  it('RV3a-F1 a copy cut to another size is found by its size alone (no hash needed) and is not overwritten either', async () => {
    const f = path.join(photosDir(w), nameOf(objects[1]));
    await truncate(f, objects[1].bytes.length - 7);
    clear(log);
    set(w, night(nextNight));
    const res = await w.tick();
    expect(res.statusCode, res.body).toBe(500);
    expect((await readFile(f)).length).toBe(objects[1].bytes.length - 7);
    const failed = (await backupRuns(w.sql, 'photo_copy')).at(-1)!;
    expect(failed.detail.verify.damaged).toEqual([expect.objectContaining({ id: objects[1].id, kind: 'full', reason: 'size' })]);
    expect((await line(w, night(nextNight, 1))).reasons).toContain('backup_photos_damaged');
    await rm(f);
    set(w, night(nextNight, 2));
    expect((await w.tick()).statusCode).toBe(200);
    expect((await readFile(f)).equals(objects[1].bytes)).toBe(true);
  });
});

describe('RV3a-F1 a copy is missing and the database no longer holds the bytes the copy was made from: nothing is written, the line is red', () => {
  it('the bytes in design_photos do not match the recorded sha256 (damage in the database): the file is not made from them', async () => {
    const log = newLog();
    const w = await tickWorld('rv3af1c', { phases: [createPhotoCopyPhase({ store: recordingStore(log, () => w) })] });
    try {
      const [a, b] = await addPhotoObjects(w.sql, 2);
      set(w, night(0));
      expect(outcome(await w.tick())).toBe('ran');
      const wrong = randomBytes(a.bytes.length);
      await w.sql.query('UPDATE design_photos SET bytes = ? WHERE id = ?', [wrong, a.id]); // same size, other bytes: the sha256 of the row no longer fits
      await rm(path.join(photosDir(w), nameOf(a)));
      clear(log);
      set(w, night(1));
      const res = await w.tick();
      expect(res.statusCode, res.body).toBe(500);
      expect(log.puts).toEqual([]);
      expect(existsSync(path.join(photosDir(w), nameOf(a)))).toBe(false);
      expect(existsSync(path.join(photosDir(w), nameOf(b)))).toBe(true);
      const failed = (await backupRuns(w.sql, 'photo_copy')).at(-1)!;
      expect(failed.detail.verify.damaged).toEqual([expect.objectContaining({ id: a.id, reason: 'database_bytes' })]);
      expect((await line(w, night(1, 1))).reasons).toContain('backup_photos_damaged');
    } finally {
      await w.close();
    }
  }, 120_000);
});

describe('RV3a-F1 the nightly check is bounded: every copy is looked at, a rolling sample is hashed, every copy is hashed within the cycle, a slice that runs out of time goes on at the next tick', () => {
  it('twelve copies, 3 hashed a night over a cycle of 4 nights: all 12 are looked at every night, at most 3 are read, and by the fifth night every copy has been read once', async () => {
    const log = newLog();
    const w = await tickWorld('rv3af1d', { phases: [createPhotoCopyPhase({ store: recordingStore(log, () => w), verify: { minFiles: 3, cycleNights: 4, maxBytes: 10_000_000 } })] });
    try {
      const objects = await addPhotoObjects(w.sql, 12, { size: 1000 });
      set(w, night(0));
      expect(outcome(await w.tick())).toBe('ran');
      const read = new Set<string>();
      for (let n = 1; n <= 5; n++) {
        clear(log);
        set(w, night(n));
        expect((await w.tick()).statusCode).toBe(200);
        expect(new Set(log.heads).size, `night ${n}: every copy is looked at`).toBe(12);
        expect(log.gets.length, `night ${n}`).toBeLessThanOrEqual(3);
        for (const g of log.gets) read.add(g);
        const detail = (await lastRun(w)).detail;
        expect(detail.verify.hashed, `night ${n}`).toBeLessThanOrEqual(3);
      }
      expect([...read].sort(), 'every copy was read within the cycle').toEqual(objects.map(nameOf).sort());
    } finally {
      await w.close();
    }
  }, 120_000);

  it('the byte limit of a night is a limit: with room for two copies only two are read, and a single copy bigger than the limit is still read (the sample always moves on)', async () => {
    const log = newLog();
    const w = await tickWorld('rv3af1e', { phases: [createPhotoCopyPhase({ store: recordingStore(log, () => w), verify: { minFiles: 10, cycleNights: 4, maxBytes: 2500 } })] });
    try {
      await addPhotoObjects(w.sql, 6, { size: 1000 }); // 1,000 bytes and a made-up prefix: about 1,010 each
      set(w, night(0));
      expect(outcome(await w.tick())).toBe('ran');
      clear(log);
      set(w, night(1));
      expect((await w.tick()).statusCode).toBe(200);
      expect(log.gets.length, '2,500 bytes of room: two copies of about 1,010').toBe(2);
      expect((await lastRun(w)).detail.verify.hashed_bytes).toBeLessThanOrEqual(2500);
    } finally {
      await w.close();
    }
    const log2 = newLog();
    const w2 = await tickWorld('rv3af1f', { phases: [createPhotoCopyPhase({ store: recordingStore(log2, () => w2), verify: { minFiles: 10, cycleNights: 4, maxBytes: 100 } })] });
    try {
      await addPhotoObjects(w2.sql, 3, { size: 1000 });
      set(w2, night(0));
      expect(outcome(await w2.tick())).toBe('ran');
      clear(log2);
      set(w2, night(1));
      expect((await w2.tick()).statusCode).toBe(200);
      expect(log2.gets.length, 'one copy is always read').toBe(1);
    } finally {
      await w2.close();
    }
  }, 120_000);

  it('a slice that runs out of its 25 seconds in the middle of the repair stops there, writes no ok row, and the next tick goes on: eight copies, three written a slice', async () => {
    const log = newLog();
    log.putCost = 10_000_000n; // a put costs 10 seconds on the test's clock: the fourth would start at 30 s
    const w = await tickWorld('rv3af1g', { phases: [createPhotoCopyPhase({ store: recordingStore(log, () => w) })] });
    try {
      const objects = await addPhotoObjects(w.sql, 8);
      log.putCost = 0n;
      set(w, night(0));
      expect(outcome(await w.tick())).toBe('ran');
      const okRows = (await backupRuns(w.sql, 'photo_copy')).length;
      await rm(photosDir(w), { recursive: true, force: true });
      log.putCost = 10_000_000n;
      clear(log);
      set(w, night(1));
      expect(outcome(await w.tick())).toBe('partial');
      expect(log.puts.length).toBe(3);
      let run = await lastRun(w);
      expect(run.status).toBe('running');
      expect((await backupRuns(w.sql, 'photo_copy')).length, 'D17: never an ok for a partial slice').toBe(okRows);
      set(w, night(1, 1));
      expect(outcome(await w.tick())).toBe('partial');
      expect(log.puts.length, 'the three after those').toBe(6);
      set(w, night(1, 2));
      expect(outcome(await w.tick())).toBe('ran');
      expect(log.puts.sort(), 'each copy written exactly once').toEqual(objects.map(nameOf).sort());
      run = await lastRun(w);
      expect(run.status).toBe('ok');
      expect(run.detail).toMatchObject({ repaired: 8, verify: { repaired: 8, missing: 8 } });
      expect((await backupRuns(w.sql, 'photo_copy')).at(-1)!.detail.verify.repaired).toBe(8);
      expect(await photoNames(w)).toEqual(objects.map(nameOf).sort());
    } finally {
      await w.close();
    }
  }, 120_000);
});
