import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Connection } from 'mysql2/promise';
import { type DumpLog, type DumpResult, type RunDumpOptions, runDumpJob } from '../../scripts/dump-job.mjs';
import { migrate } from '../../scripts/migrate.mjs';
import { createPacer } from '../../scripts/pacing.mjs';
import { type Scratch, scratchDatabase } from '../helpers';
import { V, cleanWorld, insert, uuid } from '../schema/support';
import { REPO } from './support';

// Shared by the tests of API34 (T-R03): a shop on a lane server (scratch database with the real schema, the seeds, the audit triggers and some data, two photos), an EMPTY temporary backup
// folder, a key pair made by `npm run keygen` (scripts/keygen.mjs) at run time, and the environment `scripts/job.js dump` is given. The clock is the test's: a night is an Asia/Kolkata
// instant. Nothing secret is written into a source file; the private key lives in a temporary folder with mode 0600 and is removed afterwards.

const cleanups: (() => Promise<void> | void)[] = [];
export const onCleanUp = (fn: () => Promise<void> | void) => void cleanups.push(fn);
/** Call in afterAll: drops every database, user and folder the helpers made. */
export async function cleanUp() {
  for (const fn of cleanups.splice(0).reverse()) await fn();
}

/** A temporary folder. The name has a SPACE in it on purpose: Harsh's own checkout lives under "Harsh Vishwas", so every path in the job must survive one. */
export function tempDir(label = 'jv dump ') {
  const d = mkdtempSync(path.join(tmpdir(), label));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

export const sha256Hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

export interface Keys {
  /** the private key file (0600, in a temporary folder), made by scripts/keygen.mjs */
  privateFile: string;
  privatePem: string;
  /** what BACKUP_PUBLIC_KEY holds: the base64 of the SPKI DER, one line */
  publicLine: string;
  fingerprint: string;
}

/** `npm run keygen -- <path>` (the script behind it), run as a child process: RSA 4096, a few seconds. */
export function makeKeys(): Keys {
  const dir = tempDir('jv dump keys ');
  const privateFile = path.join(dir, 'backup-private.pem');
  const run = spawnSync(process.execPath, [path.join(REPO, 'scripts/keygen.mjs'), privateFile], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`keygen failed: ${run.stderr}`);
  const lines = run.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const publicLine = lines.find((l) => /^[A-Za-z0-9+/=]{300,}$/.test(l));
  const fingerprint = lines.find((l) => /^[0-9a-f]{64}$/.test(l));
  if (!publicLine || !fingerprint) throw new Error('keygen printed no public key line');
  return { privateFile, privatePem: readFileSync(privateFile, 'utf8'), publicLine, fingerprint };
}

/** The instant of a clock reading in Asia/Kolkata: night('2026-11-02') is 03:00 that day, and nightAt('2026-11-02', '01:59') is before the gate. */
export const nightAt = (date: string, hhmm: string): number => Date.parse(`${date}T${hhmm}:00+05:30`);
export const night = (date: string): number => nightAt(date, '03:00');
/** The date `n` days after `from`. */
export const addDays = (from: string, n: number): string => new Date(Date.parse(`${from}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** DATETIME(6) text of an instant (UTC), as the job writes it. */
export const stampOf = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').replace('Z', '000');

export interface PhotoFact { id: string; kind: 'full' | 'thumb'; size: number; sha: string; bytes: Buffer }

export interface DumpWorld {
  scratch: Scratch;
  /** the ten-box user's connection, for the test's own reads and set-up */
  conn: Connection;
  /** the backup folder: an empty folder that exists */
  folder: string;
  keys: Keys;
  /** what `scripts/job.js dump` is given: DB_*, JV_BACKUP_DIR, BACKUP_PUBLIC_KEY */
  env: Record<string, string>;
  photos: PhotoFact[];
  /** the live row counts by table, now */
  counts(): Promise<Record<string, number>>;
}

let sharedKeys: Keys | null = null;
/** One key pair for a test file (RSA 4096 takes a few seconds). */
export function keysOnce(): Keys {
  sharedKeys ??= makeKeys();
  return sharedKeys;
}

const fakePng = (size: number, seed: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(size - 8, seed)]);

export interface DumpWorldOptions {
  keys?: Keys;
  /** false: the backup folder is not created (the path exists in the environment only) */
  folderExists?: boolean;
}

export async function dumpWorld(opts: DumpWorldOptions = {}): Promise<DumpWorld> {
  const scratch = await scratchDatabase('dump');
  onCleanUp(() => scratch.drop());
  const conn = await scratch.connect();
  onCleanUp(() => conn.end());
  await migrate(conn, { seeds: true, optional: true });
  const w = await cleanWorld(conn);
  const photos: PhotoFact[] = [];
  const ids = [uuid(), uuid()];
  for (const [i, id] of ids.entries()) {
    for (const [kind, size] of [['full', 4000 + i], ['thumb', 700 + i]] as const) {
      const bytes = fakePng(size, 30 + i);
      photos.push({ id, kind, size, sha: sha256Hex(bytes), bytes });
      await insert(conn, 'design_photos', { id, kind, design_id: w.design.id, mime: 'image/png', byte_size: size, sha256: Buffer.from(sha256Hex(bytes), 'hex'), bytes });
    }
  }
  await conn.query('UPDATE designs SET photo_ids = ? WHERE id = ?', [JSON.stringify(ids), w.design.id]);
  await insert(conn, 'customers', V.customer({ name: 'Siddhi जैन 💍', mobile: '9000000042', address: 'Jaishri Gold Palace, "Main" Road' }));
  const keys = opts.keys ?? keysOnce();
  const folder = tempDir('jv dump folder ');
  if (opts.folderExists === false) rmSync(folder, { recursive: true });
  const env = {
    DB_HOST: scratch.db.host,
    DB_PORT: String(scratch.db.port),
    DB_NAME: scratch.db.name,
    DB_USER: scratch.db.user,
    DB_PASSWORD: scratch.db.password,
    JV_BACKUP_DIR: folder,
    BACKUP_PUBLIC_KEY: keys.publicLine,
  };
  return {
    scratch,
    conn,
    folder,
    keys,
    env,
    photos,
    async counts() {
      const [names] = await conn.query<any[]>("SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME");
      const out: Record<string, number> = {};
      for (const r of names) out[r.n] = Number((await conn.query<any[]>(`SELECT COUNT(*) AS n FROM \`${r.n}\``))[0][0].n);
      return out;
    },
  };
}

/** A log that keeps what the job says. */
export function logCapture(): DumpLog & { lines: string[] } {
  const lines: string[] = [];
  const add = (level: string) => (message: string) => void lines.push(`${level}: ${message}`);
  return { lines, info: add('info'), warn: add('warn'), error: add('error') };
}

const fastPacer = () => createPacer({ max: 10_000 });

/** One run of the dump job at an instant (the clock is the test's). */
export function dump(world: DumpWorld, nowMs: number, extra: Partial<RunDumpOptions> = {}): Promise<DumpResult> {
  return runDumpJob({ env: world.env, nowMs: () => nowMs, pacer: fastPacer(), log: logCapture(), ...extra });
}

/** Rows of a query on the shop's database. */
export async function rows<T = any>(world: DumpWorld, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await world.conn.query<any[]>(sql, params))[0] as T[];
}

export const names = (dir: string, sub: string): string[] => (existsSync(path.join(dir, sub)) ? readdirSync(path.join(dir, sub)).sort() : []);

/** A file in the folder, with an age (milliseconds before `nowMs`, the time of the job's clock). */
export function plant(dir: string, rel: string, content = 'x', ageMs = 0, nowMs = Date.now()) {
  const full = path.join(dir, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  if (ageMs) {
    const t = (nowMs - ageMs) / 1000;
    utimesSync(full, t, t);
  }
  return full;
}

/** The backup_runs rows, oldest first. */
export const backupRuns = (world: DumpWorld, kind?: string) =>
  rows<{ id: number; ran_at: string; kind: string; ok: number; bytes: number; detail: any }>(world, `SELECT id, DATE_FORMAT(ran_at, '%Y-%m-%d %H:%i:%s.%f') AS ran_at, kind, ok, bytes, detail FROM backup_runs ${kind ? 'WHERE kind = ?' : ''} ORDER BY id`, kind ? [kind] : []);

export const jobRuns = (world: DumpWorld, job = 'db_dump') =>
  rows<{ id: number; job: string; run_date: string; status: string; started_at: string; finished_at: string | null; detail: any }>(
    world,
    "SELECT id, job, DATE_FORMAT(run_date, '%Y-%m-%d') AS run_date, status, DATE_FORMAT(started_at, '%Y-%m-%d %H:%i:%s.%f') AS started_at, DATE_FORMAT(finished_at, '%Y-%m-%d %H:%i:%s.%f') AS finished_at, detail FROM sys_job_runs WHERE job = ? ORDER BY run_date, id",
    [job]
  );

export const errorRows = (world: DumpWorld, code?: string) =>
  rows<{ id: number; level: string; code: string; message: string; detail: any }>(world, `SELECT id, level, code, message, detail FROM sys_error_log ${code ? 'WHERE code = ?' : ''} ORDER BY id`, code ? [code] : []);

/** The shape of the detail as the dashboard and the pull tool read it (mysql2 gives JSON back parsed or as text). */
export const asJson = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);
