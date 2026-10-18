import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { directoryPhotos } from '../../src/jobs/backupFolder';
import { createHousekeepingPhase } from '../../src/jobs/housekeeping';
import { defaultPhases, heartbeatPhase, nightlyCheckPhase } from '../../src/jobs/phases';
import { createPhotoCopyPhase } from '../../src/jobs/photoCopy';
import { type TickWorld, addPhotoObjects, at, body, gate, tickWorld } from './tick-support';

// T-R04 (I8, D25), the tick half, told with the application's OWN phases (PT-T1 of API33 walks the same rules with toy phases): "the nightly check and the photo copy run once for a business date
// and not before 02:00 Asia/Kolkata, a second call the same day answers `already done`, and a `running` row older than 10 minutes is run again; a second tick while one runs answers `already
// running`, a second tick after the first has ended runs, two apps on two databases of one server both run (the lock name carries the database name), and a tick that throws destroys its connection
// and releases its lock; the dump is a separate job (it is no phase of the tick); the endpoint refuses a missing or wrong token and any request with an `Origin` header". The hPanel and GitHub halves
// are OPS03.

const set = (w: TickWorld, iso: string) => {
  w.time.time.micros = at(iso);
};
const outcomes = (res: { json(): unknown }) => Object.fromEntries(((res.json() as any).phases as { job: string; outcome: string }[]).map((p) => [p.job, p.outcome]));
const order = (res: { json(): unknown }) => ((res.json() as any).phases as { job: string }[]).map((p) => p.job);
const byDate = <T extends { run_date: string }>(rows: T[], date: string): T[] => rows.filter((r) => r.run_date === date);

describe('T-R04 the application\'s phases, in the order of I8: nightly_check, the heartbeat, housekeeping, photo_copy; the dump is no phase of the tick', () => {
  it('the registry', () => {
    expect(defaultPhases().map((p) => [p.job, p.due])).toEqual([
      ['nightly_check', 'nightly'],
      ['heartbeat', 'every_tick'],
      ['housekeeping', 'every_tick'],
      ['photo_copy', 'nightly'],
    ]);
  });
});

describe('T-R04 the nightly check and the photo copy run once for a business date, not before 02:00 in Asia/Kolkata; a second call answers "already done"; a running row older than 10 minutes is run again', () => {
  let w: TickWorld;
  beforeAll(async () => {
    w = await tickWorld('tr04', { routes: true, seeds: true });
  }, 120_000);
  afterAll(async () => {
    await w?.close();
  });

  it('the first tick of 17 Oct (15:30 in Asia/Kolkata) runs every phase in order; the rows are ok; the work (not the heartbeat, not a housekeeping that had nothing to do) writes its event', async () => {
    const res = await w.tick();
    expect(res.statusCode, res.body).toBe(200);
    expect(body(res).status).toBe('ok');
    expect(order(res)).toEqual(['nightly_check', 'heartbeat', 'housekeeping', 'photo_copy']);
    expect(outcomes(res)).toEqual({ nightly_check: 'ran', heartbeat: 'ran', housekeeping: 'ran', photo_copy: 'ran' });
    expect((await w.runs()).map((r) => [r.job, r.run_date, r.status])).toEqual([
      ['nightly_check', '2026-10-17', 'ok'],
      ['heartbeat', '2026-10-17', 'ok'],
      ['housekeeping', '2026-10-17', 'ok'],
      ['photo_copy', '2026-10-17', 'ok'],
    ]);
    expect((await w.jobEvents()).map((e) => e.new_row.job)).toEqual(['nightly_check', 'photo_copy']);
    expect(Number((await w.sql.query<any[]>("SELECT COUNT(*) AS n FROM backup_runs WHERE kind = 'photo_copy' AND ok = 1"))[0][0].n)).toBe(1);
  });

  it('a second call the same day answers "already done" for the check and the copy; the heartbeat and the housekeeping are due at every tick', async () => {
    set(w, '2026-10-17T10:30:00Z');
    const res = await w.tick();
    expect(outcomes(res)).toEqual({ nightly_check: 'already_done', heartbeat: 'ran', housekeeping: 'ran', photo_copy: 'already_done' });
    expect(Number((await w.sql.query<any[]>('SELECT COUNT(*) AS n FROM check_runs'))[0][0].n)).toBe(1);
    expect(Number((await w.sql.query<any[]>("SELECT COUNT(*) AS n FROM backup_runs WHERE kind = 'photo_copy'"))[0][0].n)).toBe(1);
  });

  it('on the next business date nothing nightly runs before 02:00:00 (01:59:59.5), and both run, once, from 02:00:00', async () => {
    set(w, '2026-10-17T20:29:59.500Z');
    const early = await w.tick();
    expect(body(early).run_date).toBe('2026-10-18');
    expect(outcomes(early)).toEqual({ nightly_check: 'not_due', heartbeat: 'ran', housekeeping: 'ran', photo_copy: 'not_due' });
    for (const job of ['nightly_check', 'photo_copy']) expect(byDate(await w.runs(job), '2026-10-18'), job).toHaveLength(0);

    set(w, '2026-10-17T20:30:00.000Z');
    expect(outcomes(await w.tick())).toMatchObject({ nightly_check: 'ran', photo_copy: 'ran' });
    set(w, '2026-10-17T20:45:00.000Z');
    expect(outcomes(await w.tick())).toMatchObject({ nightly_check: 'already_done', photo_copy: 'already_done' });
    for (const job of ['nightly_check', 'photo_copy']) expect(byDate(await w.runs(job), '2026-10-18'), job).toHaveLength(1);
    expect(Number((await w.sql.query<any[]>('SELECT COUNT(*) AS n FROM check_runs'))[0][0].n)).toBe(2);
    expect(Number((await w.sql.query<any[]>("SELECT COUNT(*) AS n FROM backup_runs WHERE kind = 'photo_copy'"))[0][0].n)).toBe(2);
  });

  it('a "running" row younger than 10 minutes blocks a phase (5 minutes, 9 minutes 59 seconds), one older is run again: the same row, not a new one', async () => {
    for (const job of ['nightly_check', 'photo_copy']) await w.sql.query("INSERT INTO sys_job_runs (job, run_date, status, started_at) VALUES (?, '2026-10-19', 'running', '2026-10-18 20:25:00.000000')", [job]);
    const rows = Object.fromEntries((await w.runs()).filter((r) => r.run_date === '2026-10-19').map((r) => [r.job, r.id]));
    set(w, '2026-10-18T20:30:00Z'); // 02:00 on 19 Oct: due, started 5 minutes ago by somebody
    expect(outcomes(await w.tick())).toMatchObject({ nightly_check: 'running_elsewhere', photo_copy: 'running_elsewhere' });
    set(w, '2026-10-18T20:34:59Z');
    expect(outcomes(await w.tick())).toMatchObject({ nightly_check: 'running_elsewhere', photo_copy: 'running_elsewhere' });
    set(w, '2026-10-18T20:35:01Z');
    expect(outcomes(await w.tick())).toMatchObject({ nightly_check: 'ran', photo_copy: 'ran' });
    for (const job of ['nightly_check', 'photo_copy']) {
      const after = byDate(await w.runs(job), '2026-10-19');
      expect(after.map((r) => [r.id, r.status]), job).toEqual([[rows[job], 'ok']]);
    }
  });

  it('the door: a missing or wrong token is 401, an Origin header is 403, and nothing runs', async () => {
    const before = (await w.runs()).length;
    set(w, '2026-10-19T09:00:00Z');
    expect((await w.tick({ token: null })).statusCode).toBe(401);
    expect((await w.tick({ token: 'wrong' })).statusCode).toBe(401);
    expect((await w.tick({ headers: { origin: 'https://app.example.test' } })).statusCode).toBe(403);
    expect((await w.runs()).length).toBe(before);
  });
});

describe('T-R04 one run at a time, two databases of one server, and a tick that throws (the lock name carries the database name; the connection is destroyed and the lock released)', () => {
  let a: TickWorld; // holds the photo copy of its tick at a gate
  let b: TickWorld; // another database of the same server
  let t: TickWorld; // the photo copy throws
  const held = gate();
  let hold = true;
  let breakIt = true;

  const phasesWith = (store: (dir: string) => ReturnType<typeof directoryPhotos>) => [nightlyCheckPhase, heartbeatPhase, createHousekeepingPhase(), createPhotoCopyPhase({ store })];

  beforeAll(async () => {
    a = await tickWorld('tr04a', {
      seeds: true,
      phases: phasesWith((dir) => {
        const real = directoryPhotos(dir);
        return {
          ...real,
          async put(id, kind, bytes) {
            if (hold) {
              hold = false;
              await held.hold();
            }
            await real.put(id, kind, bytes);
          },
        };
      }),
    });
    b = await tickWorld('tr04b', { seeds: true, phases: phasesWith((dir) => directoryPhotos(dir)) });
    t = await tickWorld('tr04t', {
      seeds: true,
      phases: phasesWith((dir) => {
        const real = directoryPhotos(dir);
        return {
          ...real,
          async put(id, kind, bytes) {
            if (breakIt) throw new Error('the folder went away');
            await real.put(id, kind, bytes);
          },
        };
      }),
    });
  }, 240_000);
  afterAll(async () => {
    held.open();
    await a?.close();
    await b?.close();
    await t?.close();
  });

  it('a second tick while one runs answers "already running" at once and does nothing; two apps on two databases of the one server both run beside it; the first one then ends, and the next tick after it runs', async () => {
    await addPhotoObjects(a.sql, 1);
    const first = a.tick();
    await held.arrived; // the first tick is inside its photo copy, holding the lock of database a
    const second = await a.tick();
    expect(second.statusCode, second.body).toBe(200);
    expect(body(second)).toEqual({ status: 'already_running', run_date: null, phases: [] });

    const other = await b.tick(); // database b: another lock name
    expect(other.statusCode, other.body).toBe(200);
    expect(body(other).status).toBe('ok');
    expect(outcomes(other)).toMatchObject({ nightly_check: 'ran', photo_copy: 'ran' });

    held.open();
    const done = await first;
    expect(done.statusCode, done.body).toBe(200);
    expect(outcomes(done).photo_copy).toBe('ran');
    expect(a.conns.every((c) => c.kind === 'release')).toBe(true); // nothing went wrong: every connection went back to the pool

    a.time.time.micros += 3_600_000_000n;
    const third = await a.tick();
    expect(body(third).status).toBe('ok');
    expect(outcomes(third).photo_copy).toBe('already_done');
  });

  it('a tick that throws (the folder fails under the photo copy) answers an error, destroys its connection instead of giving it back, and leaves the lock free; the next tick runs the phase again', async () => {
    await addPhotoObjects(t.sql, 2);
    const bad = await t.tick();
    expect(bad.statusCode).toBe(500);
    expect(t.conns.map((c) => c.kind)).toContain('destroy');
    const [free] = (await t.sql.query<any[]>('SELECT IS_FREE_LOCK(?) AS free', [`jv_tick:${t.database}`]))[0];
    expect(Number(free.free)).toBe(1);
    expect((await t.runs('photo_copy'))[0].status).toBe('failed');

    breakIt = false;
    t.time.time.micros += 60_000_000n;
    const good = await t.tick();
    expect(good.statusCode, good.body).toBe(200);
    expect(outcomes(good).photo_copy).toBe('ran');
    expect((await t.runs('photo_copy'))[0].status).toBe('ok'); // the same row
    expect(Number((await t.sql.query<any[]>('SELECT COUNT(*) AS n FROM sys_photo_copies'))[0][0].n)).toBe(2);
  });
});
