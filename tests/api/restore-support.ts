import { generateKeyPairSync, createHash, randomBytes } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Connection } from 'mysql2/promise';
import { type Scratch, scratchDatabase } from '../helpers';
import { copyPhotosOnce, directoryPhotos, exportDatabase } from '../../scripts/backup.mjs';
import { folderStats, recordBackupRun, writeDailyExport } from '../../scripts/backup-folder.mjs';
import { loadPublicKey } from '../../scripts/export-file.mjs';
import { migrate } from '../../scripts/migrate.mjs';
import { V, cleanWorld, insert, uuid } from '../schema/support';

// Shared set-up of the PT-R1 tests (API36): a source "shop" on a lane server, written into a backup folder the way API34's nightly dump will write it (MB05's writeDailyExport
// and MB03's exportDatabase: API34 does not exist yet, so the check against its real file belongs to OPS05), and an empty target on the same server.
// Every secret (key pairs, passwords) is made up at run time.

const sha = (b: Buffer) => createHash('sha256').update(b).digest();
export const sha256Hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

const cleanups: (() => Promise<void> | void)[] = [];
export const onCleanUp = (fn: () => Promise<void> | void) => void cleanups.push(fn);
/** Call in afterAll: drops every database, user and folder the helpers made. */
export async function cleanUp() {
  for (const fn of cleanups.splice(0).reverse()) await fn();
}

/** A temporary folder. The name has a SPACE in it on purpose: Harsh's own checkout lives under "Harsh Vishwas", so every path in the tool must survive one. */
export function tempDir(label = 'jv rcli ') {
  const d = mkdtempSync(path.join(tmpdir(), label));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

export function makeKeys() {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const dir = tempDir('jv keys ');
  const privateFile = path.join(dir, 'backup-private.pem');
  writeFileSync(privateFile, pair.privateKey, { mode: 0o600 });
  return { publicPem: pair.publicKey, privatePem: pair.privateKey, privateFile };
}

/** PNG signature followed by noise: a "photo" that opens by its first bytes. */
export const fakePng = (size: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(size - 8)]);

export async function tableCounts(c: Connection): Promise<Record<string, number>> {
  const [names] = await c.query<any[]>("SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME");
  const out: Record<string, number> = {};
  for (const r of names) out[r.n] = Number((await c.query<any[]>(`SELECT COUNT(*) AS n FROM \`${r.n}\``))[0][0].n);
  return out;
}

export interface PhotoFact { id: string; kind: 'full' | 'thumb'; sha: string; size: number; bytes: Buffer }
export interface Shop {
  source: Scratch;
  conn: Connection;
  /** the backup folder: daily/, monthly/, photos/ */
  folder: string;
  publicPem: string;
  privatePem: string;
  privateFile: string;
  /** row counts of the source taken right before the LAST export was written */
  counts: Record<string, number>;
  photos: PhotoFact[];
  /** the id of a design photo that was removed in the source (a tombstone as it is) */
  removedPhoto: string;
  /** with gifAsPng: the id of the photo (kind thumb) that holds a GIF although its row says image/png */
  gifPhoto: string;
  /** the last export: name (daily/<date>.enc), sha256 and size, as API34 will record them in backup_runs.detail */
  newest: { name: string; sha256: string; size: number };
  exports: { name: string; sha256: string; size: number; date: string }[];
  triggers: number;
}

/** A source database with data, 3 photo ids (6 live objects) and one removed photo, exported on `dates`; the first export of the month is also linked in monthly/. */
export async function makeShop(opts: { dates?: string[]; gifAsPng?: boolean } = {}): Promise<Shop> {
  const dates = opts.dates ?? ['2026-10-15', '2026-10-16', '2026-10-17'];
  const source = await scratchDatabase('rsrc');
  cleanups.push(() => source.drop());
  const conn = await source.connect();
  cleanups.push(() => conn.end());
  await migrate(conn, { seeds: true, optional: true });

  const w = await cleanWorld(conn);
  await insert(conn, 'customers', V.customer({ name: 'Siddhi 💍 सिद्धि जैन', mobile: '9000000001', address: 'Jaishri Gold Palace, "Main" Road\nline two \\ backslash' }));
  const photos: PhotoFact[] = [];
  const ids = [uuid(), uuid(), uuid()];
  for (const id of ids) {
    for (const [kind, size] of [['full', 5000], ['thumb', 800]] as const) {
      const bytes = fakePng(size);
      photos.push({ id, kind, sha: sha(bytes).toString('hex'), size, bytes });
      await insert(conn, 'design_photos', { id, kind, design_id: w.design.id, mime: 'image/png', byte_size: size, sha256: sha(bytes), bytes });
    }
  }
  let gifPhoto = '';
  if (opts.gifAsPng) {
    // a photo row that says image/png and holds a GIF: it restores byte for byte (the sha256 is right) but does not open as a PNG
    gifPhoto = uuid();
    const gif = Buffer.concat([Buffer.from('GIF89a'), randomBytes(900)]);
    await insert(conn, 'design_photos', { id: gifPhoto, kind: 'thumb', design_id: w.design.id, mime: 'image/png', byte_size: gif.length, sha256: sha(gif), bytes: gif });
  }
  const removedPhoto = uuid();
  await insert(conn, 'design_photos', { id: removedPhoto, kind: 'full', design_id: w.design.id, mime: 'image/png', byte_size: 500, sha256: sha(Buffer.from('x')), bytes: null, removed_at: '2026-10-10 05:00:00.000000' });
  await conn.query('UPDATE designs SET photo_ids = ? WHERE id = ?', [JSON.stringify(ids), w.design.id]);
  await insert(conn, 'audit_log', { actor: uuid(), actor_role: 'owner', table_name: 'customers', row_id: w.a.id, action: 'insert', new_row: { name: 'Customer A' } });
  for (let i = 0; i < 4; i++) {
    const parent = (await insert(conn, 'bills', V.bill(w.a.id, { bill_no: `JV-2026-9${String(i).padStart(3, '0')}`, status: 'cancelled', cancel_reason: 'wrong', cancelled_at: '2026-10-04 09:00:00.000000', cancelled_on: '2026-10-04', cancelled_by: uuid(), request_id: null }))) as { id: string };
    await insert(conn, 'bills', V.bill(w.a.id, { bill_no: `JV-2026-8${String(i).padStart(3, '0')}`, reissue_of: parent.id, request_id: null }));
  }

  await conn.query("INSERT INTO sys_counters (series, last_value, seed_value) VALUES ('bill:JV:2026', 9011, 4) ON DUPLICATE KEY UPDATE last_value = 9011, seed_value = 9011"); // the re-issued bills above have numbers up to 9011 (check I5)
  const folder = tempDir('jv backup folder ');
  const keys = makeKeys();
  const publicKey = loadPublicKey(keys.publicPem);
  const store = directoryPhotos(path.join(folder, 'photos'));
  const copy = await copyPhotosOnce(conn, store);
  if (copy.failed.length) throw new Error(`photo copy failed in the test set-up: ${JSON.stringify(copy.failed)}`);
  await recordBackupRun(conn, { kind: 'photo_copy', ok: true, bytes: copy.bytes, detail: { copied: copy.copied, folder: await folderStats(folder) } });

  let counts: Record<string, number> = {};
  const exports: Shop['exports'] = [];
  let run = 0;
  for (const date of dates) {
    run += 1;
    counts = await tableCounts(conn);
    let recorded: { name: string; sha256: string; size: number } | null = null;
    const written = await writeDailyExport({
      dir: folder,
      date,
      runId: run,
      publicKey,
      exportFn: (sink: any) => exportDatabase(conn, sink, { pageSize: 50 }),
      record: async (info: any) => void (recorded = { name: info.name, sha256: info.sha256, size: info.size }),
    });
    if (!recorded) throw new Error('writeDailyExport did not call record()');
    // what API34 writes after the link: the ok row, with the export's name, sha256 and size recorded in detail.export
    await recordBackupRun(conn, { kind: 'db_dump', ok: true, bytes: written.size, detail: { export: recorded, folder: await folderStats(folder) } });
    exports.push({ ...(recorded as any), date });
  }
  const triggers = Number((await conn.query<any[]>('SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()'))[0][0].n);
  return { source, conn, folder, publicPem: keys.publicPem, privatePem: keys.privatePem, privateFile: keys.privateFile, counts, photos, removedPhoto, gifPhoto, newest: exports[exports.length - 1], exports, triggers };
}

/** An empty database with the ten-box user of A3 on the same server; the restore tool gets these settings. */
export async function makeTarget() {
  const t = await scratchDatabase('rdst');
  cleanups.push(() => t.drop());
  return { scratch: t, settings: { host: t.db.host, port: t.db.port, database: t.db.name, user: t.db.user, password: t.db.password } };
}

/** A copy of the whole backup folder: a test may delete or damage a file in it without touching the shop's own. */
export function copyFolder(from: string) {
  const to = tempDir('jv backup copy ');
  cpSync(from, to, { recursive: true });
  return to;
}

export const listDir = (d: string) => (existsSync(d) ? readdirSync(d).sort() : []);
export const readText = (f: string) => readFileSync(f, 'utf8');

/**
 * Stand-ins for OpenSSH's `ssh` and `sftp`, as two small node scripts: the master connection is a marker file at the ControlPath, `ls -1` lists a folder under FAKE_SFTP_ROOT and `get`
 * copies a file. They write every call (arguments and batch commands) to FAKE_SFTP_LOG as JSON lines. They are a test double of the transport, not of the server: the real SFTP on the
 * plan is run by OPS05.
 */
export function makeFakeOpenSsh(serverRoot: string) {
  const bin = tempDir('jv fake ssh ');
  const log = path.join(bin, 'calls.log');
  writeFileSync(log, '');
  const common = `
import { appendFileSync, copyFileSync, existsSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const log = (o) => appendFileSync(process.env.FAKE_SFTP_LOG, JSON.stringify(o) + '\\n');
const opt = (name) => { for (let i = 0; i < args.length - 1; i++) if (args[i] === '-o' && args[i + 1].startsWith(name + '=')) return args[i + 1].slice(name.length + 1).replace(/^"|"$/g, ''); return null; };
`;
  const ssh = `#!/usr/bin/env node
${common}
log({ tool: 'ssh', args });
const cp = opt('ControlPath');
if (args.includes('-O') && args[args.indexOf('-O') + 1] === 'exit') { if (cp) rmSync(cp, { force: true }); process.exit(0); }
if (args.includes('-M')) { if (!cp) process.exit(255); writeFileSync(cp, 'master'); process.exit(0); }
process.exit(255);
`;
  const sftp = `#!/usr/bin/env node
${common}
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const commands = input.split('\\n').filter(Boolean);
log({ tool: 'sftp', args, commands });
const cp = opt('ControlPath');
if (!cp || !existsSync(cp)) { console.error('Permission denied (no master connection)'); process.exit(255); }
const words = (line) => [...line.matchAll(/"((?:[^"\\\\]|\\\\.)*)"|(\\S+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/\\\\(.)/g, '$1') : m[2]));
const root = process.env.FAKE_SFTP_ROOT;
for (const line of commands) {
  const [cmd, ...rest] = words(line);
  console.log('sftp> ' + line);
  if (cmd === 'ls') {
    const target = rest.filter((w) => !w.startsWith('-')).at(-1);
    const dir = path.join(root, target);
    if (!existsSync(dir)) { console.error('Can\\'t ls: "' + target + '" not found'); process.exit(1); }
    for (const n of readdirSync(dir)) console.log(n);
  } else if (cmd === 'get') {
    const [from, to] = rest.filter((w) => !w.startsWith('-'));
    const src = path.join(root, from);
    if (!existsSync(src)) { console.error('File "' + from + '" not found.'); process.exit(1); }
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(src, to);
    console.log('Fetching ' + from + ' to ' + to);
  } else { console.error('unsupported command ' + cmd); process.exit(1); }
}
`;
  writeFileSync(path.join(bin, 'ssh'), ssh);
  writeFileSync(path.join(bin, 'sftp'), sftp);
  chmodSync(path.join(bin, 'ssh'), 0o755);
  chmodSync(path.join(bin, 'sftp'), 0o755);
  return {
    bin: { ssh: path.join(bin, 'ssh'), sftp: path.join(bin, 'sftp') },
    env: { ...process.env, FAKE_SFTP_ROOT: serverRoot, FAKE_SFTP_LOG: log },
    calls: () =>
      readText(log)
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { tool: 'ssh' | 'sftp'; args: string[]; commands?: string[] }),
  };
}
