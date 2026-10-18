import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOB_HASH, JOB_TOKEN, type TickWorld, type TickWorldOptions, at, tickWorld } from './tick-support';

// PT-T1 / T-D14 clause (API33): "each phase run of the tick writes one `event` row with role job" (D16, L1). An `event` row is what is not a change of an audited row: a job run is one. The row has no
// actor id (a job is no user), the role `job`, the request id of the tick's request, the table `sys_job_runs`, the id of the phase's row, and its facts in `new_row`: identifiers and counts, never
// a token, a hash or the text of an error.
//
// Run against both mechanisms of L1 (the generated triggers, and the Node writer on a database without them): the event row is written by the tick in the same transaction as the phase's own row in
// sys_job_runs, whichever writes the audit rows of the audited tables, and the triggers must add nothing to it.

const auditRows = async (w: TickWorld) => Number((await w.sql.query<any[]>('SELECT COUNT(*) AS n FROM audit_log'))[0][0].n);

const MECHANISMS: [string, string, TickWorldOptions][] = [
  ['triggers (L1 a)', 't', { triggers: true }],
  ['node (L1 b)', 'n', { config: { auditMode: 'node' } }],
];

describe.each(MECHANISMS)('PT-T1 / T-D14 clause: every phase run of the tick writes one event row with the role job, mechanism %s', (_name, letter, options) => {
  let w: TickWorld;
  beforeAll(async () => {
    w = await tickWorld(`tickaud${letter}`, { routes: true, seeds: true, ...options });
  }, 120_000);
  afterAll(async () => {
    await w?.close();
  });

  it('a tick that runs the nightly check adds exactly one audit row: the event of the run, no actor, role job, the request id of the call, the id of the sys_job_runs row', async () => {
    const before = await auditRows(w);
    const res = await w.tick();
    expect(res.statusCode).toBe(200);
    expect(await auditRows(w)).toBe(before + 1); // the heartbeat is not a phase of work: no event; no trigger row for sys_job_runs or check_runs
    const events = await w.jobEvents();
    expect(events).toHaveLength(1);
    const [event] = events;
    const [job] = await w.runs('nightly_check');
    expect(event.actor).toBeNull();
    expect(event.actor_role).toBe('job');
    expect(event.request_id).toBe(res.headers['x-request-id']);
    expect(event.table_name).toBe('sys_job_runs');
    expect(event.row_id).toBe(String(job.id));
    expect(event.new_row).toEqual({ event: 'job_phase', job: 'nightly_check', run_date: '2026-10-17', outcome: 'ok', check_run_id: job.detail.check_run_id, books_ok: true });
    const text = JSON.stringify(event);
    expect(text).not.toContain(JOB_TOKEN);
    expect(text).not.toContain(JOB_HASH);
  });

  it('a phase that is already done, not yet due or taken by somebody else is not a run: no event row', async () => {
    const before = await auditRows(w);
    w.time.time.micros = at('2026-10-17T10:30:00Z');
    const res = await w.tick();
    expect(JSON.stringify((res.json() as any).phases)).toContain('already_done');
    expect(await auditRows(w)).toBe(before);
    expect(await w.jobEvents()).toHaveLength(1);
  });

  it('a run that fails writes its event too (outcome failed, the error\'s class and code, never its text), in the same transaction as the failed mark', async () => {
    const root = await w.world.scratch.root();
    try {
      await root.query(`USE \`${w.database}\``);
      w.time.time.micros = at('2026-10-17T21:00:00Z'); // 02:30 on 18 Oct
      await root.query('RENAME TABLE check_runs TO check_runs_away');
      let res;
      try {
        res = await w.tick();
      } finally {
        await root.query('RENAME TABLE check_runs_away TO check_runs');
      }
      expect(res.statusCode).toBe(500);
      const events = await w.jobEvents();
      expect(events).toHaveLength(2);
      const failed = events[1];
      const [, job] = await w.runs('nightly_check');
      expect(failed.row_id).toBe(String(job.id));
      expect(failed.request_id).toBe(res.headers['x-request-id']);
      expect(failed.new_row).toMatchObject({ event: 'job_phase', job: 'nightly_check', run_date: '2026-10-18', outcome: 'failed', error_code: 'ER_NO_SUCH_TABLE' });
      expect(JSON.stringify(failed.new_row)).not.toMatch(/check_runs/); // the text of the database's message names a table: it stays out of the audit log
      expect(job.status).toBe('failed');
    } finally {
      await root.end();
    }
  });

  it('the retry that ends well is a run again: one more event, on the same sys_job_runs row, and the audit log now tells the story of the date (failed, then ok)', async () => {
    w.time.time.micros = at('2026-10-17T21:05:00Z');
    expect((await w.tick()).statusCode).toBe(200);
    const events = await w.jobEvents();
    expect(events.map((e) => [e.new_row.run_date, e.new_row.outcome])).toEqual([
      ['2026-10-17', 'ok'],
      ['2026-10-18', 'failed'],
      ['2026-10-18', 'ok'],
    ]);
    expect(events[1].row_id).toBe(events[2].row_id);
  });
});
