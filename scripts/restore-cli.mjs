#!/usr/bin/env node
// The restore and pull tool on Harsh's Mac (spec B4, B5, O54; tasks API36). Everything here uses the database half (MB03/MB05) and adds what only the Mac can do:
//
//   restore   get the export (a local folder, one file downloaded by hand from hPanel's File Manager, or SFTP with Harsh's own login), decrypt it with the PRIVATE key file (never on the
//             server, never in the repository), rebuild an EMPTY database with restoreDatabase (a database that has tables is refused before anything is read), open a sample of the
//             photos, print the report. --drill starts the throw-away MariaDB 11.8 in Docker for drill 1 by itself.
//   pull      the weekly pull (O54): the newest daily/ file (--monthly: also the newest monthly/ file and the photos that are new) into a folder on the Mac, each file checked by sha256
//             against backup_runs.detail and sys_photo_copies, create-once, optionally opened with a key holder's key, and then reported through the admin door.
//   key-test  the key holders' proof at drill 1: make a small encrypted test file with the public key, open it with your own copy of the private key.
//   drill-down  removes the drill container (and only that).
//
// No password, token or key is printed or stored here: the SFTP login is asked for by ssh on the terminal, the database settings come from the environment (DB_HOST DB_PORT DB_NAME DB_USER
// DB_PASSWORD, like the import command), the key is a file the holder names, and every connection to a database is opened through the pacer (at most 10 new in 1.2 s, S11).
//
//   node scripts/restore-cli.mjs restore --key KEYFILE --from-folder DIR | --file FILE.enc [--photos DIR] | --sftp user@host --remote-dir PATH [--port 65002] [--identity FILE]
//                                        [--name daily/2026-10-16.enc] [--drill [--tmpfs-size 3g]] [--list-photos]
//   node scripts/restore-cli.mjs pull    --dest DIR (--from-folder DIR | --file FILE.enc [--as daily/2026-10-16.enc] | --sftp user@host --remote-dir PATH ...) [--monthly]
//                                        [--key KEYFILE] [--by NAME] [--no-report] [--expect-sha256 HEX]
//   node scripts/restore-cli.mjs key-test make --public-key-file FILE --out FILE   |   key-test check --file FILE --key KEYFILE
//   node scripts/restore-cli.mjs drill-down [--drill-name NAME]
// Exit code: 0 clean, 1 refused or a check failed, 2 the command line is wrong, 4 restored but photos had to be tombstoned (the owner decides).
import { execFile, spawn } from 'node:child_process';
import { createHash, createPrivateKey, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, rm, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import mysql from 'mysql2/promise';
import { directoryPhotos, directoryStore } from './backup.mjs';
import { fileDigest } from './backup-folder.mjs';
import { folderRemote, sftpRemote } from './backup-remote.mjs';
import { createExportWriter, loadPublicKey, unpackExport } from './export-file.mjs';
import { HOSTINGER_SQL_MODE, createTenBoxUser } from './lane.mjs';
import { createPacer, pacedConnect } from './pacing.mjs';
import { restoreDatabase } from './restore.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileP = promisify(execFile);

export const EXIT = { ok: 0, failed: 1, usage: 2, photosMissing: 4 };

/** A refusal with a message written for Harsh. `code` says which kind: usage, bad_key_file, wrong_key, damaged, not_empty, no_export, no_record, mismatch, db, docker. */
export class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

const STRICT_MODE = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION';
const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const DAILY_NAME = /^(\d{4}-\d{2}-\d{2})(?:-([0-9A-Za-z][0-9A-Za-z-]{0,39}))?\.enc$/;
const MONTHLY_NAME = /^(\d{4}-\d{2})\.enc$/;
const EXPORT_NAME = /^(daily|monthly)\/(?:\d{4}-\d{2}-\d{2}(?:-[0-9A-Za-z][0-9A-Za-z-]{0,39})?|\d{4}-\d{2})\.enc$/;
const PHOTO_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(full|thumb)$/;

// ---------------------------------------------------------------- choosing files

/** The newest export name in a listing: by the date in the name. A retried night's `<date>-<run id>.enc` ties with `<date>.enc`; a name in `prefer` (the one a backup_runs record names) wins, else the plain one. */
export function newestOf(names, prefer = []) {
  const found = [];
  for (const n of names) {
    const m = DAILY_NAME.exec(n) ?? MONTHLY_NAME.exec(n);
    if (m) found.push({ name: n, key: m[1], run: m[2] ?? null });
  }
  if (found.length === 0) return null;
  const top = found.reduce((a, b) => (b.key > a.key ? b : a)).key;
  const tied = found.filter((f) => f.key === top);
  const pick = tied.find((f) => prefer.includes(f.name)) ?? tied.find((f) => f.run === null) ?? tied.sort((a, b) => (a.name < b.name ? 1 : -1))[0];
  return pick.name;
}

// ---------------------------------------------------------------- the key

function loadPrivateKey(file) {
  let text;
  try {
    text = readFileSync(file);
  } catch (e) {
    throw new ToolError('bad_key_file', `the key file ${file} cannot be read: ${e.code === 'ENOENT' ? 'it is not there' : e.message}`);
  }
  try {
    const key = createPrivateKey(text);
    if (key.asymmetricKeyType !== 'rsa') throw new Error('not an RSA key');
    return key;
  } catch (e) {
    const protectedKey = /passphrase|encrypted/i.test(String(e.message));
    throw new ToolError(
      'bad_key_file',
      protectedKey
        ? `the key file ${file} is protected by a passphrase, and this tool does not take one yet`
        : `${file} is not a private key file (the text of a private key starts with a line saying PRIVATE KEY between dashes). The public key cannot open an export; use the copy of the PRIVATE key from the password manager.`
    );
  }
}

/** unpackExport with its errors turned into plain ones. After a throw the folder is unusable; the caller removes it. */
async function unpackOrThrow(encPath, privateKey, outDir) {
  try {
    return await unpackExport(encPath, privateKey, outDir);
  } catch (e) {
    const m = String(e.message);
    if (/cannot be unwrapped/.test(m)) {
      throw new ToolError('wrong_key', 'This private key does not open this export: it is another key than the one the export was made for (or the start of the file was changed). Nothing was restored. Try the other key holder\'s copy.');
    }
    if (/authentication failed|truncated|wrong magic|damaged|trailing bytes|unsafe path|unknown frame|inside a file|end of a file|data outside|larger than any/.test(m)) {
      throw new ToolError('damaged', `The export file is damaged or was changed after it was written (${m.replace(/^cannot unpack the export: /, '')}). Nothing was restored. Pull the file again; if it is the same, use an older one.`);
    }
    throw new ToolError('damaged', `The export file cannot be read: ${m.replace(/^cannot unpack the export: /, '')}. Nothing was restored.`);
  }
}

// ---------------------------------------------------------------- the database

async function openDatabase(settings, pacer, counter, what) {
  counter.n += 1;
  let conn;
  try {
    conn = await pacedConnect(pacer, () =>
      mysql.createConnection({
        host: settings.host,
        port: Number(settings.port ?? 3306),
        user: settings.user,
        password: settings.password,
        database: settings.database,
        charset: 'utf8mb4',
        connectTimeout: 15000,
        decimalNumbers: false,
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: true,
        multipleStatements: false,
      })
    );
  } catch (e) {
    throw new ToolError('db', `cannot open the ${what} database ${settings.database ?? ''} on ${settings.host}:${settings.port ?? 3306} as ${settings.user}: ${e.code ?? e.message}`);
  }
  await conn.query("SET SESSION transaction_isolation = 'READ-COMMITTED'");
  await conn.query(`SET SESSION sql_mode = '${STRICT_MODE}'`);
  await conn.query("SET SESSION time_zone = '+00:00'");
  return conn;
}

async function assertEmpty(conn, settings) {
  const [rows] = await conn.query('SELECT DATABASE() AS db, (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()) AS n');
  const { db, n } = rows[0];
  if (!db) throw new ToolError('usage', 'the target connection has no database selected (DB_NAME)');
  if (Number(n) > 0) {
    throw new ToolError(
      'not_empty',
      `restore refused: the database ${db} is not empty (${n} tables or views). A restore only goes into a NEW empty database: the app's user has no Drop and no Delete and could not empty a damaged one (spec B5). Create a new database in hPanel, or use --drill.`
    );
  }
}

// ---------------------------------------------------------------- restore

async function livePhotoNames(exportDir) {
  const file = path.join(exportDir, 'data', 'design_photos.ndjson');
  if (!existsSync(file)) return [];
  const names = [];
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line) continue;
    const r = JSON.parse(line);
    if (r.removed_at === null) names.push(`${r.id}-${r.kind}`);
  }
  return names;
}

const MAGIC = {
  'image/png': (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

/** "20 random photos open" (B4): n random live photos are read back out of the restored database and their first bytes are checked against the type the row says. */
async function samplePhotos(conn, n) {
  const [rows] = await conn.query(`SELECT id, kind, mime, bytes FROM design_photos WHERE removed_at IS NULL AND bytes IS NOT NULL ORDER BY RAND() LIMIT ${Number(n)}`);
  const failed = [];
  let opened = 0;
  for (const r of rows) {
    const check = MAGIC[r.mime];
    if (check && check(r.bytes)) opened += 1;
    else failed.push(`${r.id}/${r.kind}`);
  }
  return { sampled: rows.length, opened, failed };
}

function formatRestoreReport({ status, report, file, target, ms, photoRows, sample, listAll, otherProblems }) {
  const out = [];
  const headline = { restored: 'RESTORED', restored_photos_missing: 'RESTORED, BUT PHOTOS WERE MISSING (the owner decides about each one)', failed_checks: 'CHECKS FAILED' }[status];
  out.push('JewelVault restore report', '=========================', `Result: ${headline}`);
  out.push(`Export: ${file.name ?? '(file given by hand)'}   sha256 ${file.sha256}   ${file.size} bytes`);
  out.push(`Database: ${target.database} on ${target.host}:${target.port ?? 3306} as ${target.user} (it was empty before the restore)`);
  out.push(`Time: ${(ms / 1000).toFixed(1)} s (drill 1 has a budget of under 2 hours)`, '');
  out.push('Tables (rows in the export, rows restored, content against the manifest):');
  const width = Math.max(10, ...report.tables.map((t) => t.name.length)) + 2;
  for (const t of report.tables) out.push(`  ${t.name.padEnd(width)}${String(t.rows_expected).padStart(9)}${String(t.rows_restored).padStart(9)}  ${t.hash_ok ? 'same' : 'DIFFERENT'}`);
  out.push(`Triggers applied last: ${report.triggers}`, `Foreign-key orphans: ${report.fk_orphans.length === 0 ? 'none' : report.fk_orphans.map((o) => `${o.rows} in ${o.table}`).join(', ')}`, '');
  const tomb = report.photos.tombstoned;
  out.push(`Photos: ${report.photos.live_expected} live in the export, ${report.photos.restored} restored with their bytes, ${tomb.length} tombstoned`);
  const shown = listAll ? photoRows : photoRows.slice(0, 40);
  for (const p of shown) out.push(`  photo ${p.id}/${p.kind}  sha256 ${p.sha}  ${p.byte_size} bytes`);
  if (photoRows.length > shown.length) out.push(`  ... and ${photoRows.length - shown.length} more (--list-photos prints all)`);
  for (const p of tomb) {
    const why = p.reason === 'missing' ? 'missing from the photo copy' : p.reason === 'size' ? 'its size in the photo copy is not the recorded one' : 'its bytes in the photo copy are not the recorded ones (sha256 differs)';
    out.push(`  TOMBSTONE ${p.id}/${p.kind}: ${why}; the row was restored as a tombstone, the owner decides`);
  }
  out.push(`${sample.opened} of ${sample.sampled} sampled photos open`);
  for (const f of sample.failed) out.push(`  photo ${f} does not open (its first bytes are not the type the row says)`);
  out.push('');
  const inv = report.invariants;
  out.push(inv ? (inv.ok ? 'Nightly check on the copy: passed' : 'Nightly check on the copy: FAILED') : 'Nightly check on the copy: not run');
  if (otherProblems.length) {
    out.push('', 'Problems:');
    for (const p of otherProblems) out.push(`  - ${p}`);
  }
  out.push('', 'Still to tick by hand (runbook B5): the unticked rights of A3 in hPanel, the cron jobs, the names of the environment variables, the domain connections, and that the backup folder is not reachable over HTTP.');
  return out.join('\n');
}

async function obtainExport(opts, workDir, log) {
  if (opts.file) {
    if (!existsSync(opts.file)) throw new ToolError('no_export', `the export file ${opts.file} is not there`);
    return { path: path.resolve(opts.file), name: null, remote: null };
  }
  const remote = opts.remote ?? folderRemote(opts.fromFolder);
  let name = opts.name;
  if (name) {
    if (!EXPORT_NAME.test(name)) throw new ToolError('usage', `${name} is not an export name like daily/2026-10-16.enc or monthly/2026-10.enc`);
  } else {
    const newest = newestOf(await remote.list('daily'));
    if (!newest) throw new ToolError('no_export', `there is no export file (daily/*.enc) in ${remote.describe}`);
    name = `daily/${newest}`;
  }
  if (remote.localRoot) {
    const p = path.join(remote.localRoot, name);
    if (!existsSync(p)) throw new ToolError('no_export', `${name} is not in ${remote.describe}`);
    return { path: p, name, remote };
  }
  const to = path.join(workDir, 'download', path.basename(name));
  log(`Downloading ${name} from ${remote.describe} ...`);
  await remote.fetch([{ name, to }]);
  return { path: to, name, remote };
}

async function resolvePhotos(opts, remote, exportDir, workDir, log) {
  if (opts.photosDir) return path.resolve(opts.photosDir);
  if (remote?.localRoot) return path.join(remote.localRoot, 'photos');
  const dir = path.join(workDir, 'photos');
  await mkdir(dir, { recursive: true });
  if (!remote) return dir; // a file downloaded by hand and no photo folder: every live photo becomes a tombstone, listed
  const live = await livePhotoNames(exportDir);
  if (live.length === 0) return dir;
  const have = new Set(await remote.list('photos'));
  const get = live.filter((n) => have.has(n)); // a photo that is not on the server is not fetched: it will be listed as missing
  log(`Downloading ${get.length} photos (${live.length - get.length} of the ${live.length} live ones are not on the server) ...`);
  await remote.fetch(get.map((n) => ({ name: `photos/${n}`, to: path.join(dir, n) })));
  return dir;
}

/** B4 on Harsh's Mac. Throws ToolError for a refusal; otherwise returns { status, report, text, ... }. */
export async function restoreBackup(opts) {
  const now = opts.now ?? Date.now;
  const t0 = now();
  const log = opts.log ?? (() => undefined);
  if ([opts.fromFolder, opts.remote, opts.file].filter(Boolean).length !== 1) throw new ToolError('usage', 'give exactly one source: --from-folder, --sftp, or --file');
  if (!opts.key) throw new ToolError('usage', 'the private key file is missing (--key)');
  if (!opts.target) throw new ToolError('usage', 'the target database is missing');
  log(`Reading the key file ${opts.key} ...`);
  const privateKey = loadPrivateKey(opts.key);
  const pacer = opts.pacer ?? createPacer();
  const counter = { n: 0 };
  const workDir = await mkdtemp(path.join(opts.workRoot ?? os.tmpdir(), 'jv-restore-'));
  await chmod(workDir, 0o700); // the unpacked export is plain customer data
  let conn;
  try {
    log(`Opening the target database ${opts.target.database} ...`);
    conn = await openDatabase(opts.target, pacer, counter, 'target');
    await assertEmpty(conn, opts.target);
    const got = await obtainExport(opts, workDir, log);
    const digest = await fileDigest(got.path);
    log(`Export ${got.name ?? got.path}: ${digest.size} bytes, sha256 ${digest.sha256}`);
    const exportDir = path.join(workDir, 'export');
    log('Decrypting with the private key ...');
    await unpackOrThrow(got.path, privateKey, exportDir);
    const photosDir = await resolvePhotos(opts, got.remote, exportDir, workDir, log);
    log('Restoring: schema, data in foreign-key order, photos, triggers, checks ...');
    const report = await restoreDatabase(conn, directoryStore(exportDir).source, directoryPhotos(photosDir), { migrationsDir: opts.migrationsDir });
    const [photoRows] = await conn.query('SELECT id, kind, LOWER(HEX(sha256)) AS sha, byte_size FROM design_photos WHERE removed_at IS NULL AND bytes IS NOT NULL ORDER BY id, kind');
    const sample = await samplePhotos(conn, opts.sample ?? 20);
    const isTombstoneLine = (p) => p.startsWith('photo ') && p.includes('restored as a tombstone');
    const otherProblems = [...report.problems.filter((p) => !isTombstoneLine(p)), ...sample.failed.map((f) => `photo ${f} does not open`)];
    const tombstoned = report.photos.tombstoned;
    const status = otherProblems.length > 0 ? 'failed_checks' : tombstoned.length > 0 ? 'restored_photos_missing' : 'restored';
    const ms = now() - t0;
    const file = { name: got.name, sha256: digest.sha256, size: digest.size };
    const text = formatRestoreReport({ status, report, file, target: opts.target, ms, photoRows, sample, listAll: opts.listPhotos === true, otherProblems });
    return { status, report, text, connections: counter.n, file, photos: { live: report.photos.live_expected, restored: report.photos.restored, tombstoned, opened: sample.opened, sampled: sample.sampled, failedToOpen: sample.failed }, ms };
  } finally {
    await conn?.end().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }
}

export function exitCodeFor(result) {
  return result.status === 'restored' ? EXIT.ok : result.status === 'restored_photos_missing' ? EXIT.photosMissing : EXIT.failed;
}

// ---------------------------------------------------------------- drill 1: the throw-away database in Docker

const DRILL_NAME = /^jv-restore-drill(-[a-z0-9]{1,12})?$/;
const checkDrillName = (name) => {
  if (!DRILL_NAME.test(name)) throw new ToolError('usage', `refusing container name ${JSON.stringify(name)}: only jv-restore-drill or jv-restore-drill-<letters and digits> are started or removed by this tool`);
  return name;
};

async function defaultDocker(args, env) {
  try {
    const { stdout } = await execFileP('docker', args, { env: env ?? process.env, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (e) {
    if (e.code === 'ENOENT') throw new ToolError('docker', 'Docker is not installed on this Mac (the drill needs Docker Desktop)');
    throw e;
  }
}

const dockerProblem = (e) => {
  const m = String(e.stderr ?? e.message);
  return e instanceof ToolError ? e : new ToolError('docker', /Cannot connect to the Docker daemon|Is the docker daemon running/i.test(m) ? 'Docker is not running: start Docker Desktop and try again' : `docker said: ${m.trim().split('\n')[0]}`);
};

/** The arguments of `docker run` for the drill database: data in tmpfs (no volume to leave behind), published on 127.0.0.1 only on a port Docker picks, Hostinger's settings, the root password in the environment. */
export function drillCommandArgs({ name, image, tmpfsSize }) {
  return [
    'run', '-d', '--name', name,
    '--label', 'jv.drill=1',
    '-p', '127.0.0.1::3306',
    '--tmpfs', `/var/lib/mysql:rw,size=${tmpfsSize}`,
    '-e', 'MARIADB_ROOT_PASSWORD', // the name only: the value travels in the environment of the docker command
    image,
    '--transaction-isolation=READ-COMMITTED', '--character-set-server=utf8mb4', '--collation-server=utf8mb4_unicode_ci', `--sql-mode=${HOSTINGER_SQL_MODE}`,
  ];
}

export async function removeDrillDatabase(name = 'jv-restore-drill', { docker = defaultDocker } = {}) {
  checkDrillName(name);
  try {
    await docker(['inspect', name]);
  } catch (e) {
    if (/No such (object|container)/i.test(String(e.stderr ?? e.message))) return false;
    throw dockerProblem(e);
  }
  await docker(['rm', '-fv', name]).catch((e) => {
    throw dockerProblem(e);
  });
  return true;
}

/** Drill 1 (B4): a MariaDB 11.8 that costs nothing and leaves nothing: an empty database and the ten-box user of A3, ready for restoreBackup. */
export async function startDrillDatabase({ name = 'jv-restore-drill', image = 'mariadb:11.8', tmpfsSize = '3g', database = 'jv_restore', docker = defaultDocker, pacer = createPacer() } = {}) {
  checkDrillName(name);
  if (!/^\d+[kmg]$/i.test(tmpfsSize)) throw new ToolError('usage', `--tmpfs-size ${tmpfsSize} is not a size like 3g`);
  try {
    await docker(['inspect', name]);
    throw new ToolError('docker', `the container ${name} already exists. A drill container is never replaced silently: look at it, or remove it with  docker rm -fv ${name}  (or: node scripts/restore-cli.mjs drill-down)`);
  } catch (e) {
    if (e instanceof ToolError) throw e;
    if (!/No such (object|container)/i.test(String(e.stderr ?? e.message))) throw dockerProblem(e);
  }
  const rootPassword = randomBytes(18).toString('base64url');
  const appPassword = randomBytes(18).toString('base64url');
  try {
    await docker(drillCommandArgs({ name, image, tmpfsSize }), { ...process.env, MARIADB_ROOT_PASSWORD: rootPassword });
  } catch (e) {
    throw dockerProblem(e);
  }
  try {
    const ports = await docker(['port', name, '3306/tcp']);
    const m = /(?:\d{1,3}\.){3}\d{1,3}:(\d+)/.exec(ports);
    if (!m) throw new ToolError('docker', `cannot read the port of ${name} from: ${ports}`);
    const port = Number(m[1]);
    const rootSettings = { host: '127.0.0.1', port, user: 'root', password: rootPassword };
    let last;
    let root = null;
    for (let i = 0; i < 90 && !root; i++) {
      try {
        root = await pacedConnect(pacer, () => mysql.createConnection({ ...rootSettings, connectTimeout: 5000 }));
        await root.query('SELECT 1');
      } catch (e) {
        last = e;
        await root?.end().catch(() => undefined);
        root = null;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (!root) throw new ToolError('docker', `the drill database did not become ready in 90 s: ${last?.message}`);
    try {
      await root.query(`CREATE DATABASE ${mysql.escapeId(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      await createTenBoxUser(root, { database, user: 'jv_restore', password: appPassword });
    } finally {
      await root.end().catch(() => undefined);
    }
    return { name, target: { host: '127.0.0.1', port, database, user: 'jv_restore', password: appPassword }, remove: () => removeDrillDatabase(name, { docker }) };
  } catch (e) {
    await docker(['rm', '-fv', name]).catch(() => undefined); // a container that never came up is not left behind
    throw e instanceof ToolError ? e : dockerProblem(e);
  }
}

// ---------------------------------------------------------------- what the pull compares against

/** backup_runs.detail.export (written by the dump before it links the file) and sys_photo_copies, read through a connection that only needs SELECT. */
export function dbRecords(conn) {
  return {
    async exportRecords() {
      const [rows] = await conn.query(
        "SELECT JSON_VALUE(detail, '$.export.name') AS name, JSON_VALUE(detail, '$.export.sha256') AS sha256, JSON_VALUE(detail, '$.export.size') AS size FROM backup_runs WHERE kind = 'db_dump' AND JSON_VALUE(detail, '$.export.name') IS NOT NULL ORDER BY id"
      );
      return rows.map((r) => ({ name: r.name, sha256: String(r.sha256).toLowerCase(), size: r.size === null ? null : Number(r.size) }));
    },
    async photoRecords() {
      const [rows] = await conn.query('SELECT photo_id, kind, LOWER(HEX(sha256)) AS sha256, size FROM sys_photo_copies');
      return new Map(rows.map((r) => [`${r.photo_id}-${r.kind}`, { sha256: r.sha256, size: Number(r.size) }]));
    },
  };
}

/** For a file downloaded by hand when no database can be reached: the sha256 read off the dashboard or phpMyAdmin. Photos cannot be checked this way. */
export function manualRecords(sha256, size = null) {
  if (!/^[0-9a-f]{64}$/i.test(String(sha256))) throw new Error('the sha256 must be 64 hex characters');
  return {
    exportRecords: async () => [{ name: null, sha256: String(sha256).toLowerCase(), size }],
    photoRecords: async () => new Map(),
  };
}

// ---------------------------------------------------------------- the pull

const deriveName = (file, as) => {
  if (as) {
    if (!EXPORT_NAME.test(as)) throw new ToolError('usage', `${as} is not an export name like daily/2026-10-16.enc or monthly/2026-10.enc`);
    return as;
  }
  const base = path.basename(file);
  if (DAILY_NAME.test(base)) return `daily/${base}`;
  if (MONTHLY_NAME.test(base)) return `monthly/${base}`;
  throw new ToolError('usage', `the file name ${base} does not say which export it is: add  --as daily/2026-10-16.enc  (or monthly/2026-10.enc)`);
};

/** The record that decides about an export: the newest record of a daily name; for a monthly file (a hard link of the month's first dump) any dump of that month with the same sha256; a hash typed in by hand. */
function recordFor(name, digest, records) {
  const manual = records.find((r) => r.name === null);
  if (manual) return manual;
  if (name.startsWith('daily/')) return [...records].reverse().find((r) => r.name === name) ?? null;
  const month = path.basename(name, '.enc');
  return records.find((r) => r.name?.startsWith(`daily/${month}-`) && r.sha256 === digest.sha256) ?? [...records].reverse().find((r) => r.name?.startsWith(`daily/${month}-`)) ?? null;
}

async function linkOnce(from, to) {
  try {
    await link(from, to);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

async function sha256OfFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** O54 / T-R06: the weekly pull. */
export async function pullBackup(opts) {
  const log = opts.log ?? (() => undefined);
  const now = opts.now ?? (() => new Date());
  if ([opts.fromFolder, opts.remote, opts.file].filter(Boolean).length !== 1) throw new ToolError('usage', 'give exactly one source: --from-folder, --sftp, or --file');
  if (!opts.dest) throw new ToolError('usage', 'the folder to pull into is missing (--dest)');
  const dest = path.resolve(opts.dest);
  const exportRecords = await opts.records.exportRecords();
  const items = [];
  const problems = [];
  const workRoot = opts.workRoot ?? os.tmpdir();

  const single = opts.file ? { name: deriveName(opts.file, opts.as), from: path.resolve(opts.file) } : null;
  if (single && !existsSync(single.from)) throw new ToolError('no_export', `the file ${single.from} is not there`);
  const remote = single ? null : (opts.remote ?? folderRemote(opts.fromFolder));

  // ---- which files
  const wanted = [];
  let photoNames = [];
  if (single) wanted.push(single.name);
  else {
    const preferred = exportRecords.filter((r) => r.name?.startsWith('daily/')).map((r) => r.name.slice('daily/'.length));
    const newestDaily = newestOf(await remote.list('daily'), preferred);
    if (!newestDaily) throw new ToolError('no_export', `there is no export file (daily/*.enc) in ${remote.describe}`);
    wanted.push(`daily/${newestDaily}`);
    if (opts.monthly) {
      const newestMonthly = newestOf(await remote.list('monthly'));
      if (newestMonthly) wanted.push(`monthly/${newestMonthly}`);
      photoNames = (await remote.list('photos')).filter((n) => PHOTO_NAME.test(n));
    }
  }

  // ---- download what is not in the destination yet (one session), under .partial names
  const partials = new Map();
  const fetchList = [];
  for (const name of wanted) {
    if (existsSync(path.join(dest, name))) continue;
    const to = `${path.join(dest, name)}.${randomBytes(4).toString('hex')}.partial`;
    partials.set(name, to);
    fetchList.push({ name, to });
  }
  const photoRecords = await opts.records.photoRecords();
  const photoTodo = [];
  for (const n of photoNames) {
    const name = `photos/${n}`;
    if (!photoRecords.has(n)) {
      items.push({ name, state: 'skipped_unrecorded' });
      continue;
    }
    if (existsSync(path.join(dest, name))) continue;
    const to = `${path.join(dest, name)}.${randomBytes(4).toString('hex')}.partial`;
    partials.set(name, to);
    photoTodo.push({ name, to });
  }
  try {
    if (single) {
      for (const f of fetchList) {
        await mkdir(path.dirname(f.to), { recursive: true });
        await copyFile(single.from, f.to);
      }
    } else if (fetchList.length > 0) {
      log(`Downloading ${fetchList.map((f) => f.name).join(', ')} ...`);
      await remote.fetch(fetchList);
    }
    if (photoTodo.length > 0) {
      log(`Downloading ${photoTodo.length} new photos ...`);
      await remote.fetch(photoTodo);
    }
  } catch (e) {
    for (const p of partials.values()) await unlink(p).catch(() => undefined);
    throw e;
  }

  // ---- check every file against its record, keep it create-once
  const verified = new Map();
  for (const name of wanted) {
    const final = path.join(dest, name);
    const partial = partials.get(name);
    const file = partial ?? final;
    const digest = { sha256: await sha256OfFile(file), size: (await stat(file)).size };
    const rec = recordFor(name, digest, exportRecords);
    if (!rec) {
      problems.push(`${name}: there is no record of it in backup_runs, so its sha256 ${digest.sha256} cannot be checked${partial ? '; it was not kept' : ''}`);
      items.push({ name, state: 'missing_record', sha256: digest.sha256, size: digest.size });
    } else if (rec.sha256 !== digest.sha256 || (rec.size !== null && rec.size !== digest.size)) {
      problems.push(`${name}: its sha256 ${digest.sha256} (${digest.size} bytes) does not match the record (${rec.sha256}${rec.size === null ? '' : `, ${rec.size} bytes`}): the file was changed or damaged${partial ? '; it was not kept' : '; the copy in the destination is not trusted'}`);
      items.push({ name, state: 'mismatch', sha256: digest.sha256, size: digest.size });
    } else {
      if (partial) {
        await mkdir(path.dirname(final), { recursive: true });
        await linkOnce(partial, final);
      }
      items.push({ name, state: partial ? 'new' : 'already', sha256: digest.sha256, size: digest.size });
      verified.set(name, digest);
    }
    if (partial) await unlink(partial).catch(() => undefined);
  }
  for (const n of photoNames) {
    const name = `photos/${n}`;
    if (!photoRecords.has(n)) continue;
    const final = path.join(dest, name);
    const partial = partials.get(name);
    const file = partial ?? final;
    const rec = photoRecords.get(n);
    const digest = { sha256: await sha256OfFile(file), size: (await stat(file)).size };
    if (digest.sha256 !== rec.sha256 || digest.size !== rec.size) {
      problems.push(`${name}: its sha256 ${digest.sha256} does not match sys_photo_copies (${rec.sha256}); ${partial ? 'it was not kept' : 'the copy in the destination is not trusted'}`);
      items.push({ name, state: 'mismatch', sha256: digest.sha256, size: digest.size });
    } else {
      if (partial) {
        await mkdir(path.dirname(final), { recursive: true });
        await linkOnce(partial, final);
      }
      items.push({ name, state: partial ? 'new' : 'already', sha256: digest.sha256, size: digest.size });
    }
    if (partial) await unlink(partial).catch(() => undefined);
  }

  // ---- the first export in the list is the newest daily one
  const newestName = wanted[0];
  const newestDigest = verified.get(newestName) ?? null;
  const newest = newestDigest ? { name: newestName, sha256: newestDigest.sha256, size: newestDigest.size } : null;

  // ---- a key holder's proof: the pulled export opens (T-R06)
  let decrypted = null;
  if (opts.key && newest) {
    const dir = await mkdtemp(path.join(workRoot, 'jv-pull-'));
    await chmod(dir, 0o700);
    try {
      await unpackOrThrow(path.join(dest, newest.name), loadPrivateKey(opts.key), path.join(dir, 'export'));
      const manifest = JSON.parse(await readFile(path.join(dir, 'export', 'manifest.json'), 'utf8'));
      for (const t of manifest.tables) {
        if ((await sha256OfFile(path.join(dir, 'export', t.file))) !== t.sha256) throw new ToolError('damaged', `the table file ${t.file} inside the export does not match its manifest`);
      }
      decrypted = true;
    } catch (e) {
      decrypted = false;
      problems.push(`${newest.name} does not decrypt with this key: ${e.message}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const failed = problems.length > 0;
  let reported = false;
  if (!failed && newest && opts.reportPull) {
    const facts = { at: now().toISOString(), by: opts.by ?? os.userInfo().username, file: newest.name, sha256: newest.sha256 };
    try {
      await opts.reportPull(facts);
      reported = true;
    } catch (e) {
      problems.push(`the pull could not be reported through the admin door: ${e.message}`);
    }
  }
  const text = formatPull({ items, problems, newest, decrypted, reported, dest, reporting: !!opts.reportPull, failed });
  return { status: failed ? 'failed' : 'pulled', newest, items, problems, decrypted, reported, text };
}

function formatPull({ items, problems, newest, decrypted, reported, dest, reporting, failed }) {
  const out = ['JewelVault pull report', '======================', `Result: ${failed ? 'FAILED' : 'PULLED'}`, `Kept in: ${dest}`];
  if (newest) out.push(`Newest export: ${newest.name}   sha256 ${newest.sha256}   ${newest.size} bytes (matches its record)`);
  const count = (s) => items.filter((i) => i.state === s).length;
  out.push(`Files: ${count('new')} new, ${count('already')} already here, ${count('mismatch')} did not match, ${count('missing_record')} without a record, ${count('skipped_unrecorded')} skipped`);
  for (const i of items.filter((x) => x.state === 'skipped_unrecorded')) out.push(`  ${i.name}: no sys_photo_copies row, so it is not taken (the copy is recorded only after its size was checked)`);
  if (decrypted !== null) out.push(`Decrypted with the key file you gave: ${decrypted ? 'yes' : 'NO'}`);
  out.push(reporting ? (reported ? 'Reported through the admin door (last pulled is updated).' : 'NOT reported through the admin door.') : 'Not reported (no admin door call was asked for).');
  if (problems.length) {
    out.push('', 'Problems:');
    for (const p of problems) out.push(`  - ${p}`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- reporting the pull through the admin door (API09)

/** `npm run admin -- record-pull ...` with the facts of the pull (recordPull of housekeeping.mjs stores `{at, by, file, sha256}` in settings.last_pulled). The admin command asks for the token itself. */
export function adminRecordPullCommand(facts) {
  return { command: 'npm', args: ['run', 'admin', '--', 'record-pull', '--file', facts.file, '--sha256', facts.sha256, '--at', facts.at, '--by', facts.by] };
}

function defaultRun(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['inherit', 'inherit', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d;
      process.stderr.write(d);
    });
    child.on('error', (e) => reject(new Error(`cannot start ${command}: ${e.message}`)));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

export async function runAdminRecordPull(facts, { run = defaultRun, cwd = ROOT } = {}) {
  const { command, args } = adminRecordPullCommand(facts);
  const r = await run(command, args, cwd);
  if (r.code === 0) return;
  if (/Missing script/i.test(r.stderr)) {
    throw new Error(`the admin door command is not built yet (npm run admin comes with API09); the pull is safe in the folder, report it later with: ${[command, ...args].join(' ')}`);
  }
  throw new Error(`the admin door refused or did not record the pull (npm run admin ended with code ${r.code})`);
}

// ---------------------------------------------------------------- the key holders' proof (B4, drill 1)

const KEY_TEST_MARKER = 'JewelVault key test v1';

/** A tiny encrypted file made with the PUBLIC key; each key holder opens it with their own copy of the private key. Created once, never overwritten. */
export async function makeKeyTestFile(publicKeyText, outFile) {
  const key = loadPublicKey(publicKeyText);
  const partial = `${outFile}.${randomBytes(4).toString('hex')}.partial`;
  const writer = await createExportWriter(partial, key);
  try {
    const f = writer.sink.file('key-test.txt');
    await f.write(`${KEY_TEST_MARKER}\n${randomBytes(8).toString('hex')}\n`);
    await f.close();
    const done = await writer.finish();
    await link(partial, outFile); // EEXIST: an existing file is never overwritten
    return done;
  } catch (e) {
    await writer.abort().catch(() => undefined);
    throw e;
  } finally {
    await unlink(partial).catch(() => undefined);
  }
}

export async function checkKeyTestFile(encFile, keyFile, workRoot = os.tmpdir()) {
  const privateKey = loadPrivateKey(keyFile);
  const dir = await mkdtemp(path.join(workRoot, 'jv-keytest-'));
  try {
    await unpackOrThrow(encFile, privateKey, path.join(dir, 'out'));
    const text = await readFile(path.join(dir, 'out', 'key-test.txt'), 'utf8').catch(() => '');
    if (!text.startsWith(KEY_TEST_MARKER)) throw new ToolError('damaged', 'the file opened, but it is not a JewelVault key test file');
    return { ok: true };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- command line

const VALUE_FLAGS = new Set(['key', 'from-folder', 'file', 'photos', 'sftp', 'remote-dir', 'port', 'identity', 'name', 'tmpfs-size', 'drill-name', 'dest', 'as', 'by', 'expect-sha256', 'public-key-file', 'out']);
const BOOL_FLAGS = new Set(['drill', 'list-photos', 'monthly', 'no-report', 'help']);

function parseArgs(argv) {
  const flags = new Map();
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const name = a.slice(2);
    if (BOOL_FLAGS.has(name)) flags.set(name, true);
    else if (VALUE_FLAGS.has(name)) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new ToolError('usage', `--${name} needs a value`);
      flags.set(name, argv[++i]);
    } else throw new ToolError('usage', `unknown option --${name}`);
  }
  return { flags, positional };
}

const USAGE = `usage:
  node scripts/restore-cli.mjs restore --key KEYFILE (--from-folder DIR | --file FILE.enc [--photos DIR] | --sftp user@host --remote-dir PATH [--port 65002] [--identity FILE])
                                       [--name daily/2026-10-16.enc] [--drill [--tmpfs-size 3g]] [--list-photos]
      the target database (not with --drill) comes from the environment: DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD
  node scripts/restore-cli.mjs pull --dest DIR (--from-folder DIR | --file FILE.enc [--as daily/2026-10-16.enc] | --sftp user@host --remote-dir PATH ...)
                                    [--monthly] [--key KEYFILE] [--by NAME] [--no-report] [--expect-sha256 HEX]
      the record to check against is read from the database in the same DB_* variables (SELECT only), or given as --expect-sha256 for a file downloaded by hand
  node scripts/restore-cli.mjs key-test make --public-key-file FILE --out FILE
  node scripts/restore-cli.mjs key-test check --file FILE --key KEYFILE
  node scripts/restore-cli.mjs drill-down [--drill-name NAME]`;

function dbFromEnv(env = process.env) {
  const missing = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'].filter((k) => !env[k]);
  if (missing.length) throw new ToolError('usage', `missing settings in the environment: ${missing.join(', ')} (the connection is never taken from a file or the command line)`);
  return { host: env.DB_HOST, port: Number(env.DB_PORT || 3306), database: env.DB_NAME, user: env.DB_USER, password: env.DB_PASSWORD };
}

function sourceFromFlags(flags) {
  const picked = ['from-folder', 'file', 'sftp'].filter((f) => flags.has(f));
  if (picked.length !== 1) throw new ToolError('usage', 'give exactly one of --from-folder, --file, --sftp');
  if (flags.has('from-folder')) return { fromFolder: path.resolve(flags.get('from-folder')) };
  if (flags.has('file')) return { file: path.resolve(flags.get('file')) };
  if (!flags.has('remote-dir')) throw new ToolError('usage', '--sftp needs --remote-dir (the backup folder on the server, JV_BACKUP_DIR)');
  try {
    return { remote: sftpRemote({ target: flags.get('sftp'), port: flags.has('port') ? Number(flags.get('port')) : 65002, dir: flags.get('remote-dir'), identityFile: flags.get('identity') }) };
  } catch (e) {
    throw new ToolError('usage', e.message);
  }
}

async function main(argv) {
  const { flags, positional } = parseArgs(argv);
  const [command, sub] = positional;
  const log = (l) => console.error(l);
  if (!command || flags.has('help') || command === 'help') {
    console.log(USAGE);
    return command ? EXIT.ok : EXIT.usage;
  }
  if (command === 'drill-down') {
    const name = flags.get('drill-name') ?? 'jv-restore-drill';
    console.log((await removeDrillDatabase(name)) ? `drill container ${name} removed` : `no container ${name}`);
    return EXIT.ok;
  }
  if (command === 'key-test') {
    if (sub === 'make') {
      if (!flags.has('public-key-file') || !flags.has('out')) throw new ToolError('usage', 'key-test make needs --public-key-file and --out');
      const done = await makeKeyTestFile(readFileSync(flags.get('public-key-file'), 'utf8'), path.resolve(flags.get('out')));
      console.log(`key test file written: ${flags.get('out')} (${done.size} bytes, sha256 ${done.sha256}). Give it to each key holder.`);
      return EXIT.ok;
    }
    if (sub === 'check') {
      if (!flags.has('file') || !flags.has('key')) throw new ToolError('usage', 'key-test check needs --file and --key');
      await checkKeyTestFile(path.resolve(flags.get('file')), flags.get('key'));
      console.log('The key opens the test file: this holder can decrypt.');
      return EXIT.ok;
    }
    throw new ToolError('usage', USAGE);
  }
  if (command === 'restore') {
    if (!flags.has('key')) throw new ToolError('usage', 'restore needs --key (the private key file)');
    const source = sourceFromFlags(flags);
    let drill = null;
    try {
      if (flags.has('drill')) {
        log('Starting the throw-away MariaDB 11.8 in Docker (drill 1) ...');
        drill = await startDrillDatabase({ name: flags.get('drill-name') ?? 'jv-restore-drill', tmpfsSize: flags.get('tmpfs-size') ?? '3g' });
      }
      const result = await restoreBackup({
        key: flags.get('key'), ...source, photosDir: flags.has('photos') ? path.resolve(flags.get('photos')) : undefined,
        name: flags.get('name'), target: drill ? drill.target : dbFromEnv(), listPhotos: flags.has('list-photos'), log,
      });
      console.log(result.text);
      if (drill) console.log(`\nThe drill database is still running as ${drill.name} on 127.0.0.1:${drill.target.port}. Remove it when you are done:  node scripts/restore-cli.mjs drill-down`);
      return exitCodeFor(result);
    } finally {
      await source.remote?.close();
    }
  }
  if (command === 'pull') {
    if (!flags.has('dest')) throw new ToolError('usage', 'pull needs --dest (the folder on the Mac that keeps the pulled copy)');
    const source = sourceFromFlags(flags);
    const pacer = createPacer();
    const counter = { n: 0 };
    let conn = null;
    try {
      let records;
      if (flags.has('expect-sha256')) records = manualRecords(flags.get('expect-sha256'));
      else {
        conn = await openDatabase(dbFromEnv(), pacer, counter, 'record');
        records = dbRecords(conn);
      }
      const result = await pullBackup({
        dest: path.resolve(flags.get('dest')), ...source, as: flags.get('as'), monthly: flags.has('monthly'), records, key: flags.get('key'),
        reportPull: flags.has('no-report') ? undefined : (facts) => runAdminRecordPull(facts), by: flags.get('by'), log,
      });
      console.log(result.text);
      return result.status === 'pulled' && (flags.has('no-report') || result.reported) ? EXIT.ok : EXIT.failed;
    } finally {
      await conn?.end().catch(() => undefined);
      await source.remote?.close();
    }
  }
  throw new ToolError('usage', USAGE);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => void (process.exitCode = code),
    (e) => {
      console.error(e instanceof ToolError ? e.message : `${e.message}`);
      process.exitCode = e instanceof ToolError && e.code === 'usage' ? EXIT.usage : EXIT.failed;
    }
  );
}
