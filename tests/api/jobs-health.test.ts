import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { formatTimestamp } from '../../src/clock';
import { DAY, HOUR, MINUTE, dropSetting, putSetting, resetHealth } from './download-support';
import { timestampToWire } from '../../src/wire/format';
import { JOB_HASH, JOB_TOKEN, type TickWorld, body, freshIp, tickWorld } from './tick-support';

// T-R04 (I8, B3, O44): `GET /internal/jobs/health`, the read-only call of the GitHub Actions workflow (same token as the tick): "answers 503 when the last good export is older than 26 hours or the owner's
// last Download everything is more than 35 days old (B3), and the workflow then fails". Only those two decide; the owner's other red lights (a stale check, no photo copy, a fallen file count) are for
// the dashboard line (I12). It is behind the same door as the tick: no Origin, the tick's throttle, the job token, no CORS; and it writes nothing.

// The throttle of the door counts in the API's clock, 20 calls a minute in all: every test starts two minutes after the last one, and what is "now" is read from the clock each time.
const WRITES = /^\s*(INSERT|UPDATE|DELETE|REPLACE|ANALYZE|ALTER|CREATE|DROP|TRUNCATE)\b/i;

describe('T-R04 jobs/health: 503 on an export older than 26 hours and on a download more than 35 days old', () => {
  let w: TickWorld;
  let root: Awaited<ReturnType<TickWorld['world']['scratch']['root']>>;

  beforeAll(async () => {
    w = await tickWorld('jobshealth', { routes: true, seeds: true });
    root = await w.world.scratch.root();
    await root.query(`USE \`${w.database}\``);
  }, 120_000);
  afterAll(async () => {
    await root?.end();
    await w?.close();
  });

  const now = () => w.time.time.micros;
  beforeEach(() => {
    w.time.time.micros += 2n * MINUTE;
  });
  const get = async () => {
    const res = await w.health();
    return { res, json: body(res) };
  };
  /** the owner's line is good at `now`, apart from what the test then changes */
  const good = async (shift = 0n) => {
    await resetHealth(w.world, root, now() - shift);
    await putSetting(w.sql, 'last_download', now() - 10n * DAY);
  };

  it('everything good: 200 { ok: true } with the age of the export and of the download, and nothing that names a customer, a user or a path', async () => {
    await good();
    const { res, json } = await get();
    expect(res.statusCode, res.body).toBe(200);
    expect(json).toEqual({
      ok: true,
      failing: [],
      dump: { last_at: timestampToWire(formatTimestamp(now() - HOUR)), age_hours: 1 },
      download: { state: 'ok', age_days: 10, from: 'last_download' },
    });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('the export: 25 h 59 min old is 200, 26 h 01 min old is 503 naming dump_stale (the line of the owner turns red above 26 hours)', async () => {
    await good(24n * HOUR + 59n * MINUTE); // the export is made one hour before "now" in resetHealth: 25 h 59 min
    const young = await get();
    expect(young.res.statusCode, young.res.body).toBe(200);
    expect(young.json.dump.age_hours).toBe(25.98);

    await good(25n * HOUR + MINUTE); // 26 h 01 min
    const old = await get();
    expect(old.res.statusCode, old.res.body).toBe(503);
    expect(old.json).toMatchObject({ ok: false, failing: ['dump_stale'], dump: { age_hours: 26.02 } });
  });

  it('no good export has ever been made: 503 naming dump_never (the same word as the owner\'s line: "never ran" is red on purpose)', async () => {
    await good();
    await root.query('DELETE FROM backup_runs WHERE kind = ?', ['db_dump']);
    const { res, json } = await get();
    expect(res.statusCode).toBe(503);
    expect(json).toMatchObject({ ok: false, failing: ['dump_never'], dump: { last_at: null, age_hours: null } });
  });

  it('a dump that failed (ok false) does not count: only a GOOD export keeps the call green', async () => {
    await good(2n * DAY);
    await w.sql.query("INSERT INTO backup_runs (ran_at, kind, ok, bytes, detail) VALUES (?, 'db_dump', 0, 0, '{}')", [formatTimestamp(now() - MINUTE)]);
    const { res, json } = await get();
    expect(res.statusCode).toBe(503);
    expect(json.failing).toEqual(['dump_stale']);
  });

  it('the download: 28 to 35 days is only the reminder (200); 36 days, whole Asia/Kolkata days, is 503 naming download_red', async () => {
    for (const [days, status] of [[28n, 200], [35n, 200], [36n, 503]] as const) {
      await good();
      await putSetting(w.sql, 'last_download', now() - days * DAY);
      const { res, json } = await get();
      expect([String(days), res.statusCode, res.body], res.body).toEqual([String(days), status, res.body]);
      if (status === 503) expect(json).toMatchObject({ ok: false, failing: ['download_red'], download: { state: 'red', age_days: 36 } });
      else expect(json).toMatchObject({ ok: true, failing: [], download: { age_days: Number(days) } });
    }
  });

  it('with no download ever, the days count from the first night the system ran (B3); a new shop is not red', async () => {
    await good();
    await dropSetting(root, w.world, 'last_download');
    await resetHealth(w.world, root, now(), { firstNightAt: now() - 20n * DAY });
    const young = await get();
    expect(young.res.statusCode).toBe(200);
    expect(young.json.download).toMatchObject({ from: 'first_night', age_days: 20 });
    await resetHealth(w.world, root, now(), { firstNightAt: now() - 36n * DAY });
    const old = await get();
    expect(old.res.statusCode).toBe(503);
    expect(old.json.failing).toEqual(['download_red']);
  });

  it('both lapses are named together; and only those two decide: a stale check, a photo copy that never ran, a fallen file count and a full database leave the answer at 200', async () => {
    await good(2n * DAY);
    await putSetting(w.sql, 'last_download', now() - 40n * DAY);
    const both = await get();
    expect(both.json.failing).toEqual(['dump_stale', 'download_red']);

    await good();
    await root.query('DELETE FROM check_runs');
    await root.query("DELETE FROM backup_runs WHERE kind = 'photo_copy'");
    await w.sql.query("INSERT INTO backup_runs (ran_at, kind, ok, bytes, detail) VALUES (?, 'db_dump', 1, 1, ?)", [formatTimestamp(now() - 30n * MINUTE), JSON.stringify({ folder: { files: 1, bytes: 1 } })]); // the file count fell from 7 to 1
    const dashboard = await w.world.call('owner', 'GET', '/v1/dashboard/health');
    expect(dashboard.statusCode).toBe(200);
    expect(body(dashboard).level).toBe('red'); // the owner's line is red
    expect(body(dashboard).reasons).toEqual(expect.arrayContaining(['check_never', 'photo_copy_never', 'backup_files_fell']));
    const { res, json } = await get();
    expect(res.statusCode, res.body).toBe(200); // but the outside check is about the export and the download
    expect(json).toMatchObject({ ok: true, failing: [] });
  });

  it('it is read only: no statement that writes, no audit row, no row in sys_job_runs, and the connection goes back to the pool', async () => {
    await good();
    const audit = Number((await w.sql.query<any[]>('SELECT COUNT(*) AS n FROM audit_log'))[0][0].n);
    const runs = (await w.runs()).length;
    const sent = w.world.spy.sent.length;
    const conns = w.conns.length;
    expect((await get()).res.statusCode).toBe(200);
    const statements = w.world.spy.sent.slice(sent).map((s) => s.sql);
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.filter((s) => WRITES.test(s))).toEqual([]);
    expect(Number((await w.sql.query<any[]>('SELECT COUNT(*) AS n FROM audit_log'))[0][0].n)).toBe(audit);
    expect((await w.runs()).length).toBe(runs);
    expect(w.conns.slice(conns).map((c) => c.kind)).toEqual(['release']);
  });

  it('the door: no token or a wrong token is 401, an Origin header is 403, no CORS header and no preflight, the answer to a POST or a tick address is not the health', async () => {
    await good();
    for (const token of [null, 'wrong', `${JOB_TOKEN}x`]) {
      const res = await w.health({ token });
      expect(res.statusCode, String(token)).toBe(401);
      expect((res.json() as any).error.code).toBe('JV_UNAUTHENTICATED');
      expect(res.body).not.toContain(JOB_HASH);
    }
    const page = await w.health({ headers: { origin: 'https://evil.example.test' } });
    expect(page.statusCode).toBe(403);
    expect(page.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await w.world.app.inject({ method: 'OPTIONS', url: '/internal/jobs/health', headers: { origin: 'https://app.example.test', 'access-control-request-method': 'GET', 'x-real-ip': freshIp() } });
    expect(preflight.statusCode).toBe(404);
    const post = await w.health({ method: 'POST' });
    expect(post.statusCode).toBe(404);
  });

  it('it is behind the throttle of the tick (A13): the 7th call of a minute from one address is 429 with Retry-After, and the right token does not get round it', async () => {
    w.time.time.micros += 5n * MINUTE; // a new window
    const ip = '203.0.113.77';
    const answers: number[] = [];
    let retryAfter: unknown;
    for (let i = 0; i < 7; i++) {
      const res = await w.health({ ip });
      answers.push(res.statusCode);
      retryAfter = res.headers['retry-after'];
    }
    expect(answers.slice(0, 6).every((s) => s === 200 || s === 503)).toBe(true);
    expect(answers[6]).toBe(429);
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });
});

describe('T-R04 jobs/health does not exist without the job token hash (like the tick)', () => {
  it('a world with no JV_JOB_TOKEN_HASH answers 404 for both addresses', async () => {
    const w = await tickWorld('jobshealthd', { routes: true, door: false });
    try {
      const health = await w.health();
      const tick = await w.tick();
      expect([health.statusCode, tick.statusCode]).toEqual([404, 404]);
      expect(createHash('sha256').update(JOB_TOKEN).digest('hex')).toBe(JOB_HASH);
    } finally {
      await w.close();
    }
  }, 120_000);
});
