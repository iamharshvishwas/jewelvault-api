import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkPhases, defaultPhases, heartbeatPhase, nightlyCheckPhase } from '../../src/jobs/phases';
import { runTick } from '../../src/jobs/tick';
import { type TickWorld, at, body, tickWorld, toyPhase } from './tick-support';

// PT-T1 (API33), the phases of the tick (I8, D25): "each phase has one row in `sys_job_runs` for the business date in Asia/Kolkata (unique on `job` and `run_date`), so a retry is an update and not a
// new row: `failed` goes back to `running` on the next run, a `running` row older than 10 minutes counts as abandoned and is taken over, and `ok` ends the phase for that date. A phase is due when it
// is not `ok` for today's date and, for the nightly work, it is after 02:00 in Asia/Kolkata; a second call the same day answers "already done"."
//
// Part 1 walks the rules with toy phases (so the clock can stop at the exact edges); part 2 runs the real `nightly_check` and the heartbeat. The clock only moves forward (S5), so each part is one
// story told in order.

const set = (w: TickWorld, iso: string) => {
  w.time.time.micros = at(iso);
};
const outcomes = (res: { json(): unknown }) => Object.fromEntries(((res.json() as any).phases as { job: string; outcome: string }[]).map((p) => [p.job, p.outcome]));
const byDate = <T extends { run_date: string }>(rows: T[], date: string): T[] => rows.filter((r) => r.run_date === date);

describe('PT-T1 the phase table: due, once for a business date, retry by update, abandoned after 10 minutes', () => {
  let w: TickWorld;
  let failNext = false;
  const daily = toyPhase('t_daily', 'daily');
  const every = toyPhase('t_every', 'every_tick');
  const nightly = toyPhase('t_nightly', 'nightly');
  const flaky = toyPhase('t_flaky', 'daily', () => {
    if (failNext) throw new Error('the phase broke');
    return { complete: true };
  });
  const stuck = toyPhase('t_stuck', 'daily');
  let sliceTarget = 1_000_000; // the slices a run needs; the story of the slicing sets it
  const slicer = toyPhase('t_slicer', 'daily', (ctx) => {
    const done = Number((ctx.previous?.detail as any)?.slices ?? 0) + 1;
    return { complete: done >= sliceTarget, detail: { slices: done }, facts: { slices: done } };
  });
  const phases = [daily, every, nightly, flaky, stuck, slicer];

  beforeAll(async () => {
    w = await tickWorld('tickph', { phases });
  }, 120_000);
  afterAll(async () => {
    await w?.close();
  });

  it('the first tick of a business date runs every phase that is due: row per phase for the date, status ok, the date is the Asia/Kolkata date', async () => {
    // 17 Oct 10:00 UTC is 15:30 in Asia/Kolkata
    const res = await w.tick();
    expect(res.statusCode).toBe(200);
    const b = body(res);
    expect(b.run_date).toBe('2026-10-17');
    expect(outcomes(res)).toEqual({ t_daily: 'ran', t_every: 'ran', t_nightly: 'ran', t_flaky: 'ran', t_stuck: 'ran', t_slicer: 'partial' });
    const rows = await w.runs();
    expect(rows.map((r) => [r.job, r.run_date, r.status])).toEqual([
      ['t_daily', '2026-10-17', 'ok'],
      ['t_every', '2026-10-17', 'ok'],
      ['t_nightly', '2026-10-17', 'ok'],
      ['t_flaky', '2026-10-17', 'ok'],
      ['t_stuck', '2026-10-17', 'ok'],
      ['t_slicer', '2026-10-17', 'running'], // a slice that stopped early is not `ok`
    ]);
    expect(rows[0].finished_at).not.toBeNull();
    expect(rows[5].finished_at).not.toBeNull(); // the slice has ended: nobody is working on it
    expect(rows[5].detail).toEqual({ slices: 1 }); // where it stopped
  });

  it('a second call the same day answers "already done" for the daily and the nightly phase, runs the every-tick phase again on the same row, and goes on with the unfinished slice', async () => {
    const before = await w.runs('t_every');
    set(w, '2026-10-17T10:02:00Z');
    const res = await w.tick();
    expect(outcomes(res)).toEqual({ t_daily: 'already_done', t_every: 'ran', t_nightly: 'already_done', t_flaky: 'already_done', t_stuck: 'already_done', t_slicer: 'partial' });
    expect(daily.runs).toHaveLength(1);
    expect(nightly.runs).toHaveLength(1);
    expect(every.runs).toHaveLength(2);
    const after = await w.runs('t_every');
    expect(after).toHaveLength(1); // a retry is an update, never a new row
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].status).toBe('ok');
    expect(after[0].started_at > before[0].started_at).toBe(true);
  });

  it('a nightly phase is not due before 02:00 in Asia/Kolkata (01:59:59.5 on the new business date), a daily one is; no row is made for the phase that is not due', async () => {
    set(w, '2026-10-17T20:29:59.500Z'); // 01:59:59.5 on 18 Oct in Asia/Kolkata
    const res = await w.tick();
    expect(body(res).run_date).toBe('2026-10-18');
    expect(outcomes(res)).toMatchObject({ t_nightly: 'not_due', t_daily: 'ran', t_every: 'ran' });
    expect(nightly.runs).toHaveLength(1);
    expect(byDate(await w.runs('t_nightly'), '2026-10-18')).toHaveLength(0);
  });

  it('at 02:00:00 sharp it is due, and runs once for the business date', async () => {
    set(w, '2026-10-17T20:30:00.000Z'); // 02:00:00.000 on 18 Oct
    expect(outcomes(await w.tick())).toMatchObject({ t_nightly: 'ran' });
    expect(nightly.runs).toHaveLength(2);
    set(w, '2026-10-17T20:45:00.000Z');
    expect(outcomes(await w.tick())).toMatchObject({ t_nightly: 'already_done' });
    expect(nightly.runs).toHaveLength(2);
    expect(byDate(await w.runs('t_nightly'), '2026-10-18')).toHaveLength(1);
  });

  it('a phase that throws is marked failed, the tick answers an error, and on the next run the same row goes back to running and ends ok', async () => {
    set(w, '2026-10-18T19:00:00Z'); // 00:30 on 19 Oct, a new business date: it fails there first
    failNext = true;
    const bad = await w.tick();
    expect(bad.statusCode).toBe(500);
    const failed = byDate(await w.runs('t_flaky'), '2026-10-19');
    expect(failed).toHaveLength(1);
    expect(failed[0].status).toBe('failed');
    expect(failed[0].finished_at).not.toBeNull();
    failNext = false;
    set(w, '2026-10-18T19:00:30Z');
    const good = await w.tick();
    expect(good.statusCode).toBe(200);
    expect(outcomes(good).t_flaky).toBe('ran');
    const retried = byDate(await w.runs('t_flaky'), '2026-10-19');
    expect(retried).toHaveLength(1); // not a new row
    expect(retried[0].id).toBe(failed[0].id);
    expect(retried[0].status).toBe('ok');
  });

  it('a running row younger than 10 minutes is left alone (9 min 59 s), one older than 10 minutes counts as abandoned and is taken over: the same row, started again, not a new one', async () => {
    // 20 Oct: somebody started t_stuck at 00:25 UTC-ish and never finished
    set(w, '2026-10-19T18:50:00Z'); // 00:20 on 20 Oct
    const stuckStart = '2026-10-19 18:45:00.000000';
    await w.sql.query("INSERT INTO sys_job_runs (job, run_date, status, started_at) VALUES ('t_stuck', '2026-10-20', 'running', ?)", [stuckStart]);
    const row = (await w.runs('t_stuck')).find((r) => r.run_date === '2026-10-20')!;
    const runsBefore = stuck.runs.length;

    set(w, '2026-10-19T18:50:00Z'); // 5 minutes old
    expect(outcomes(await w.tick()).t_stuck).toBe('running_elsewhere');
    set(w, '2026-10-19T18:54:59Z'); // 9 minutes 59 seconds old
    expect(outcomes(await w.tick()).t_stuck).toBe('running_elsewhere');
    expect(stuck.runs).toHaveLength(runsBefore);

    set(w, '2026-10-19T18:55:01Z'); // 10 minutes 1 second old
    expect(outcomes(await w.tick()).t_stuck).toBe('ran');
    expect(stuck.runs).toHaveLength(runsBefore + 1);
    const taken = byDate(await w.runs('t_stuck'), '2026-10-20');
    expect(taken).toHaveLength(1);
    expect(taken[0].id).toBe(row.id);
    expect(taken[0].status).toBe('ok');
    expect(taken[0].started_at > stuckStart).toBe(true);
  });

  it('a phase that works in slices stays running between them, the next tick goes on at once from `previous.detail`, and it is `ok` only when a slice says complete', async () => {
    set(w, '2026-10-20T19:00:00Z'); // 00:30 on 21 Oct: a business date nobody has touched
    sliceTarget = 3;
    expect(outcomes(await w.tick()).t_slicer).toBe('partial');
    let row = byDate(await w.runs('t_slicer'), '2026-10-21')[0];
    expect(row).toMatchObject({ status: 'running', detail: { slices: 1 } });
    expect(row.finished_at).not.toBeNull();
    expect(slicer.runs.at(-1)!.previous).toBeNull();

    set(w, '2026-10-20T19:00:05Z'); // five seconds later, not ten minutes
    expect(outcomes(await w.tick()).t_slicer).toBe('partial');
    expect(slicer.runs.at(-1)!.previous).toMatchObject({ status: 'running', detail: { slices: 1 } });
    row = byDate(await w.runs('t_slicer'), '2026-10-21')[0];
    expect(row).toMatchObject({ status: 'running', detail: { slices: 2 } });

    set(w, '2026-10-20T19:00:10Z');
    expect(outcomes(await w.tick()).t_slicer).toBe('ran');
    const done = byDate(await w.runs('t_slicer'), '2026-10-21');
    expect(done).toHaveLength(1); // one row for the date, however many slices
    expect(done[0]).toMatchObject({ status: 'ok', detail: { slices: 3 } });
    expect(done[0].id).toBe(row.id);
    set(w, '2026-10-20T19:00:15Z');
    expect(outcomes(await w.tick()).t_slicer).toBe('already_done');
    sliceTarget = 1_000_000;
  });

  it('no phase is started once the call is over (the handler timer fired or the client went): the rest are "skipped", nothing is claimed for them', async () => {
    const ac = new AbortController();
    const first = toyPhase('s_first', 'every_tick', () => (ac.abort(), { complete: true }));
    const second = toyPhase('s_second', 'every_tick');
    set(w, '2026-10-19T19:40:00Z');
    const result = await runTick(w.world.app, { phases: [first, second], requestId: randomUUID(), signal: ac.signal });
    expect(result.phases).toEqual([
      { job: 's_first', outcome: 'ran' },
      { job: 's_second', outcome: 'skipped' },
    ]);
    expect(second.runs).toHaveLength(0);
    expect(await w.runs('s_second')).toHaveLength(0);
    expect(await w.runs('s_first')).toHaveLength(1);
  });
});

describe('PT-T1 a list of phases is checked when it is registered', () => {
  it('a name that does not fit sys_job_runs.job, a name twice and an unknown schedule are refused', () => {
    const ok = toyPhase('fine_name_1', 'daily');
    expect(() => checkPhases([ok])).not.toThrow();
    for (const bad of ['', 'Upper', '1starts_with_digit', 'has space', 'x'.repeat(41)]) expect(() => checkPhases([toyPhase(bad, 'daily')]), bad).toThrow(/name of a phase/);
    expect(() => checkPhases([ok, toyPhase('fine_name_1', 'daily')])).toThrow(/twice/);
    expect(() => checkPhases([toyPhase('x', 'hourly' as 'daily')])).toThrow(/nightly, daily or every_tick/);
    expect(() => checkPhases([toyPhase('x'.repeat(40), 'daily')])).not.toThrow();
  });
});

describe('PT-T1 the application\'s own phases: nightly_check (API32) and the heartbeat, then housekeeping and photo_copy (API33b, tests/api/tick-t-r04.test.ts), in the order of I8', () => {
  it('the registry lists them in the order of I8', () => {
    expect(defaultPhases().map((p) => [p.job, p.due])).toEqual([
      ['nightly_check', 'nightly'],
      ['heartbeat', 'every_tick'],
      ['housekeeping', 'every_tick'],
      ['photo_copy', 'nightly'],
    ]);
  });
});

describe('PT-T1 the real nightly check inside the tick: once for a business date, not before 02:00 Asia/Kolkata, an abandoned running row run again, a failed run retried by update', () => {
  let w: TickWorld;
  const checkRuns = async () => (await w.sql.query<any[]>('SELECT id, ok, details FROM check_runs ORDER BY id'))[0].map((r: any) => ({ ...r, id: Number(r.id), ok: Number(r.ok), details: typeof r.details === 'string' ? JSON.parse(r.details) : r.details }));
  beforeAll(async () => {
    // the check and the heartbeat alone: the rules of this part are those of the nightly check inside the tick (the other two phases are proved in tick-t-r04.test.ts and tick-housekeeping.test.ts)
    w = await tickWorld('ticknight', { phases: [nightlyCheckPhase, heartbeatPhase], seeds: true });
  }, 120_000);
  afterAll(async () => {
    await w?.close();
  });

  it('the first tick of 17 Oct runs the check on the tick\'s own connection (the one that holds the job lock): one check_runs row for the date, one sys_job_runs row, and a second call the same day answers "already done"', async () => {
    const res = await w.tick();
    expect(res.statusCode).toBe(200);
    expect(body(res).run_date).toBe('2026-10-17');
    expect(outcomes(res)).toEqual({ nightly_check: 'ran', heartbeat: 'ran' });
    const runs = await checkRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].ok).toBe(1);
    expect(runs[0].details.date).toBe('2026-10-17');
    const job = await w.runs('nightly_check');
    expect(job.map((r) => [r.run_date, r.status])).toEqual([['2026-10-17', 'ok']]);
    expect(job[0].detail).toMatchObject({ check_run_id: runs[0].id, books_ok: true, date: '2026-10-17' });

    // the lock and the check ran on one connection: the statements of this tick that name GET_LOCK, check_runs and RELEASE_LOCK all come from one thread
    const sent = w.world.spy.sent;
    const lock = sent.find((s) => s.sql.includes('GET_LOCK'))!;
    const insert = sent.find((s) => s.sql.startsWith('INSERT INTO check_runs'))!;
    const release = sent.find((s) => s.sql.includes('RELEASE_LOCK'))!;
    expect(new Set([lock.thread, insert.thread, release.thread]).size).toBe(1);

    set(w, '2026-10-17T10:30:00Z');
    const again = await w.tick();
    expect(outcomes(again)).toEqual({ nightly_check: 'already_done', heartbeat: 'ran' });
    expect(await checkRuns()).toHaveLength(1);
  });

  it('before 02:00 in Asia/Kolkata on the next business date nothing runs; a running row younger than 10 minutes blocks, one older than 10 minutes is run again on the same row', async () => {
    set(w, '2026-10-17T20:29:59.500Z'); // 01:59:59.5 on 18 Oct
    expect(outcomes(await w.tick()).nightly_check).toBe('not_due');
    expect(byDate(await w.runs('nightly_check'), '2026-10-18')).toHaveLength(0);
    expect(await checkRuns()).toHaveLength(1);

    await w.sql.query("INSERT INTO sys_job_runs (job, run_date, status, started_at) VALUES ('nightly_check', '2026-10-18', 'running', '2026-10-17 20:25:00.000000')");
    const row = byDate(await w.runs('nightly_check'), '2026-10-18')[0];
    set(w, '2026-10-17T20:30:00.000Z'); // 02:00:00: due, but somebody started it 5 minutes ago
    expect(outcomes(await w.tick()).nightly_check).toBe('running_elsewhere');
    set(w, '2026-10-17T20:34:59Z'); // 9 minutes 59 seconds
    expect(outcomes(await w.tick()).nightly_check).toBe('running_elsewhere');
    expect(await checkRuns()).toHaveLength(1);

    set(w, '2026-10-17T20:35:01Z'); // 10 minutes 1 second: abandoned
    expect(outcomes(await w.tick()).nightly_check).toBe('ran');
    const after = byDate(await w.runs('nightly_check'), '2026-10-18');
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(row.id);
    expect(after[0].status).toBe('ok');
    const runs = await checkRuns();
    expect(runs).toHaveLength(2);
    expect(runs[1].details.date).toBe('2026-10-18');
  });

  it('a check that fails (here: its check_runs table is missing for a moment) is marked failed with no check_runs row, the tick answers an error, and the next tick runs the same row again and ends ok', async () => {
    const root = await w.world.scratch.root();
    try {
      await root.query(`USE \`${w.database}\``);
      set(w, '2026-10-18T21:00:00Z'); // 02:30 on 19 Oct
      await root.query('RENAME TABLE check_runs TO check_runs_away');
      let bad;
      try {
        bad = await w.tick();
      } finally {
        await root.query('RENAME TABLE check_runs_away TO check_runs');
      }
      expect(bad.statusCode).toBe(500);
      const failed = byDate(await w.runs('nightly_check'), '2026-10-19');
      expect(failed).toHaveLength(1);
      expect(failed[0].status).toBe('failed');
      expect(failed[0].detail.error).toBeDefined();
      expect(await checkRuns()).toHaveLength(2); // no row for a verdict nobody reached

      set(w, '2026-10-18T21:01:00Z');
      const good = await w.tick();
      expect(good.statusCode).toBe(200);
      const retried = byDate(await w.runs('nightly_check'), '2026-10-19');
      expect(retried).toHaveLength(1);
      expect(retried[0].id).toBe(failed[0].id);
      expect(retried[0].status).toBe('ok');
      expect(await checkRuns()).toHaveLength(3);
    } finally {
      await root.end();
    }
  });

  it('the heartbeat: one row for each business date, written at every tick (its finished_at moves), never `failed`, and no event row for it', async () => {
    const rows = await w.runs('heartbeat');
    expect(rows.map((r) => r.run_date)).toEqual(['2026-10-17', '2026-10-18', '2026-10-19']);
    expect(rows.every((r) => r.status === 'ok' && r.finished_at !== null)).toBe(true);
    const first = rows[0];
    set(w, '2026-10-18T21:30:00Z');
    await w.tick();
    const later = (await w.runs('heartbeat')).find((r) => r.run_date === '2026-10-19')!;
    const beforeLast = rows.find((r) => r.run_date === '2026-10-19')!;
    expect(later.id).toBe(beforeLast.id);
    expect(later.finished_at! > beforeLast.finished_at!).toBe(true);
    expect(first.detail).toMatchObject({ last_tick_at: expect.any(String) });
    expect((await w.jobEvents()).filter((e) => e.new_row.job === 'heartbeat')).toHaveLength(0);
  });
});
