import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sftpRemote } from '../../scripts/backup-remote.mjs';
import { dbRecords, pullBackup, restoreBackup } from '../../scripts/restore-cli.mjs';
import { canConnect, freePort } from './support';
import { type Shop, cleanUp, listDir, makeShop, makeTarget, onCleanUp, sha256Hex, tempDir } from './restore-support';
import { readFileSync } from 'node:fs';

// PT-R1, the SFTP path, against a REAL OpenSSH server: sshd is started for this test only, as the current user, on 127.0.0.1 and a free port, with a throw-away host key and client key made
// here (key login only, no password, nothing outside the temp folder, stopped at the end). The tool uses the same ssh and sftp programs it uses on the Mac, so what the stand-ins of
// restore-cli.test.ts cannot show is shown here: the master connection that goes to the background, a listing that prints whole paths, a batch that stops at the first missing file, paths with spaces.
// Hostinger's own SFTP (port 65002, Harsh's login) is still untried: that is OPS05. The test is skipped where sshd or ssh-keygen is not installed.

const SSHD = ['/usr/sbin/sshd'].find((p) => existsSync(p));
const KEYGEN = ['/usr/bin/ssh-keygen'].find((p) => existsSync(p));
const enabled = Boolean(SSHD && KEYGEN);

let shop: Shop;
let sshd: ChildProcess | null = null;
let port = 0;
let serverRoot = '';
let clientKey = '';
let sshOptions: string[] = [];
const login = `${os.userInfo().username}@127.0.0.1`;

beforeAll(async () => {
  if (!enabled) return;
  shop = await makeShop();
  const dir = tempDir('jvsshd-'); // no space: sshd_config would need quotes
  serverRoot = path.join(tempDir('jv server '), 'server root');
  cpSync(shop.folder, path.join(serverRoot, 'jv backup'), { recursive: true });
  execFileSync(KEYGEN!, ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(dir, 'host_key')]);
  clientKey = path.join(dir, 'client_key');
  execFileSync(KEYGEN!, ['-q', '-t', 'ed25519', '-N', '', '-f', clientKey]);
  writeFileSync(path.join(dir, 'authorized_keys'), readFileSync(`${clientKey}.pub`), { mode: 0o600 });
  port = await freePort();
  writeFileSync(
    path.join(dir, 'sshd_config'),
    [
      `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${path.join(dir, 'host_key')}`, `PidFile ${path.join(dir, 'sshd.pid')}`, `AuthorizedKeysFile ${path.join(dir, 'authorized_keys')}`,
      'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PubkeyAuthentication yes', 'UsePAM no', 'StrictModes no', 'Subsystem sftp internal-sftp', 'LogLevel ERROR', `AllowUsers ${os.userInfo().username}`,
    ].join('\n') + '\n'
  );
  sshd = spawn(SSHD!, ['-D', '-e', '-f', path.join(dir, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] });
  let sshdLog = '';
  sshd.stderr!.on('data', (d) => void (sshdLog += d));
  onCleanUp(() => void sshd?.kill());
  for (let i = 0; i < 50 && !(await canConnect(port)); i++) await new Promise((r) => setTimeout(r, 100));
  expect(await canConnect(port), `sshd did not start: ${sshdLog.slice(0, 400)}`).toBe(true);
  sshOptions = ['-o', `UserKnownHostsFile=${path.join(dir, 'known_hosts')}`, '-o', 'StrictHostKeyChecking=no', '-o', 'IdentitiesOnly=yes', '-o', 'LogLevel=ERROR'];
}, 120_000);
afterAll(async () => {
  sshd?.kill();
  await cleanUp();
}, 60_000);

const remoteFor = () => sftpRemote({ target: login, port, dir: path.join(serverRoot, 'jv backup'), identityFile: clientKey, sshOptions, masterStdio: 'ignore', tmpRoot: tempDir('jv sock ') });

describe.skipIf(!enabled)('PT-R1 over a real OpenSSH server (key login on 127.0.0.1)', () => {
  it('lists the sub-folders, fetches several files with spaces in their paths in one batch, and a missing file stops the batch with its name', async () => {
    const remote = remoteFor();
    try {
      expect(await remote.list('daily')).toEqual(['2026-10-15.enc', '2026-10-16.enc', '2026-10-17.enc']);
      expect(await remote.list('monthly')).toEqual(['2026-10.enc']);
      expect((await remote.list('photos')).length).toBe(6);
      const out = tempDir('jv out ');
      await remote.fetch([
        { name: 'daily/2026-10-17.enc', to: path.join(out, 'a b', 'x.enc') },
        { name: `photos/${shop.photos[0].id}-${shop.photos[0].kind}`, to: path.join(out, 'a b', 'p') },
      ]);
      expect(sha256Hex(readFileSync(path.join(out, 'a b', 'x.enc')))).toBe(shop.newest.sha256);
      expect(sha256Hex(readFileSync(path.join(out, 'a b', 'p')))).toBe(shop.photos[0].sha);
      await expect(remote.fetch([{ name: 'photos/00000000-0000-4000-8000-000000000000-full', to: path.join(out, 'nope') }])).rejects.toThrow(/00000000-0000-4000-8000-000000000000-full/);
      await expect(remote.list('daily').then(() => sftpRemote({ target: login, port, dir: path.join(serverRoot, 'no such folder'), identityFile: clientKey, sshOptions, masterStdio: 'ignore', tmpRoot: tempDir('jv sock ') }).list('daily'))).rejects.toThrow(/no such folder/);
    } finally {
      await remote.close();
    }
  }, 120_000);

  it('restores the newest export from the server into an empty database, and the control connection is gone afterwards', async () => {
    const remote = remoteFor();
    const t = await makeTarget();
    const r = await restoreBackup({ key: shop.privateFile, remote, target: t.settings, workRoot: tempDir('jv work ') });
    await remote.close();
    expect(r.report.problems).toEqual([]);
    expect(r.status).toBe('restored');
    expect(r.file.sha256).toBe(shop.newest.sha256);
    expect(r.photos.restored).toBe(6);
  }, 180_000);

  it('a photo missing on the server is listed and tombstoned (the batch does not stop at it); the monthly pull checks every hash', async () => {
    const gone = shop.photos[3];
    rmSync(path.join(serverRoot, 'jv backup', 'photos', `${gone.id}-${gone.kind}`));
    const remote = remoteFor();
    const t = await makeTarget();
    const r = await restoreBackup({ key: shop.privateFile, remote, target: t.settings, workRoot: tempDir('jv work ') });
    expect(r.status).toBe('restored_photos_missing');
    expect(r.photos.tombstoned).toEqual([{ id: gone.id, kind: gone.kind, reason: 'missing' }]);

    const c = await shop.source.connect();
    const dest = tempDir('jv pulled ');
    const pulled = await pullBackup({ dest, remote, monthly: true, records: dbRecords(c), key: shop.privateFile, workRoot: tempDir('jv work ') });
    await c.end();
    await remote.close();
    expect(pulled.problems).toEqual([]);
    expect(pulled.status).toBe('pulled');
    expect(pulled.decrypted).toBe(true);
    expect(listDir(path.join(dest, 'photos'))).toHaveLength(5);
    expect(listDir(path.join(dest, 'monthly'))).toEqual(['2026-10.enc']);
  }, 180_000);
});
