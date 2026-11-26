import { createHash, randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { passwords } from '../../src/auth/password';
import { resetWork } from '../../src/auth/resetRoutes';
import { buildApp } from '../../src/app';
import { createClock } from '../../src/clock';
import type { MailConfig } from '../../src/config';
import type { MailMessage, Mailer } from '../../src/mail/mailer';
import { SESSION_COOKIE, microsOfDbTimestamp } from '../../src/permissions/session';
import { T0, type World, makeWorld } from './cells';
import { csrfHeaders, secret, testConfig } from './support';

// Forgot password by e-mail (Completion-Plan/password-help-2026-11-26, part 2, Task 3): POST /v1/auth/forgot-password and POST /v1/auth/reset-password, and the plan's Review Focus 1, 4 and 5.
//
// One world (a scratch database with the real schema and the application's own routes) on a clock the tests move, with a fake mailer that keeps every message it is handed (and, while `failWith` is set,
// rejects it the way an SMTP server that refuses does). The forgot route answers before it does its work; every test waits for that work (resetWork.idle) and for the error log before it looks.
// Every forgot call comes from an address of its own, unless the test is about the address limit, so the 10 an hour of one address is never reached by accident. The tests run in order and the
// last one scans everything the others left behind.

const MINUTE = 60_000_000n; // in microseconds, the unit of the API's clock
const HOUR = 60n * MINUTE;
const LINK_BASE = 'https://crm.example.test/reset-password';
const MAIL: MailConfig = { from: 'Jaishri Gold Palace <no-reply@example.test>', resetLinkBase: LINK_BASE, transport: { kind: 'outbox', dir: '/nowhere' } };
const BAD_LINK = 'token has expired or was already used';

/** The fake mailer: `attempted` is every message it was handed, `sent` the ones it accepted. While `failWith` is set every send rejects with it. */
const outbox = { attempted: [] as MailMessage[], sent: [] as MailMessage[], failWith: null as Error | null };
const fakeMailer: Mailer = {
  async send(message) {
    outbox.attempted.push(message);
    if (outbox.failWith) throw outbox.failWith;
    outbox.sent.push(message);
  },
};

let micros = T0;
let world: World;
let PASSWORD: string;
let HASH: string;
/** Every password a test typed, for the last test's scan. */
const typed: string[] = [];

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const LINK = new RegExp(`${LINK_BASE.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}#t=([A-Za-z0-9_-]+)`);
const tokenOf = (m: MailMessage): string => {
  const t = LINK.exec(m.text)?.[1];
  if (t === undefined) throw new Error('the mail holds no link');
  return t;
};
const newPassword = () => {
  const p = secret('New');
  typed.push(p);
  return p;
};

let addressNumber = 0;
const nextAddress = () => {
  addressNumber += 1;
  return `198.18.${(addressNumber >> 8) & 255}.${addressNumber & 255}`;
};

const forgot = (email: string, address: string = nextAddress()) =>
  world.app.inject({ method: 'POST', url: '/v1/auth/forgot-password', headers: { ...csrfHeaders(), 'x-real-ip': address }, payload: { email } });
const reset = (token: string, password: string) => world.app.inject({ method: 'POST', url: '/v1/auth/reset-password', headers: csrfHeaders(), payload: { token, new_password: password } });
const login = (email: string, password: string) =>
  world.app.inject({ method: 'POST', url: '/v1/auth/login', headers: { ...csrfHeaders(), 'x-real-ip': nextAddress() }, payload: { email, password } });
/** The lines the forgot route wrote for an ask that was over a limit and got no link: the limit that refused it, and nothing about who asked. */
const LIMIT_LINE = 'forgot-password: an ask over its limit got no link';
const limitLines = (limit: 'email' | 'address') => world.logs.lines().filter((l) => l.msg === LIMIT_LINE && l.limit === limit);
/** The work after the answer, and the rows it handed to the error log. */
const settle = async () => {
  await resetWork.idle();
  await world.app.errorLog.idle();
};

const errorOf = (res: LightMyRequestResponse) => (res.json() as { error: { code: string; message: string; details: Record<string, unknown> } }).error;
function expectBadLink(res: LightMyRequestResponse, what: string) {
  expect(res.statusCode, what).toBe(422);
  expect(errorOf(res), what).toEqual({ code: 'JV_INVALID_INPUT', message: BAD_LINK, details: { field: 'token' } });
}

interface LinkRow {
  id: string;
  token_hash: string;
  email_at_request: string;
  password_mark: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}
const linksOf = async (userId: string) =>
  (await world.sql.query<any[]>('SELECT id, token_hash, email_at_request, password_mark, created_at, expires_at, used_at FROM sys_password_resets WHERE user_id = ? ORDER BY created_at, id', [userId]))[0] as LinkRow[];
const userRow = async (userId: string) => (await world.sql.query<any[]>('SELECT * FROM users WHERE id = ?', [userId]))[0][0] as Record<string, any>;
const sessionsOf = async (userId: string) => (await world.sql.query<any[]>('SELECT id, revoked_at FROM sessions WHERE user_id = ? ORDER BY created_at, id', [userId]))[0] as { id: string; revoked_at: string | null }[];
const maxId = async (table: 'audit_log' | 'sys_error_log') => Number((await world.sql.query<any[]>(`SELECT COALESCE(MAX(id), 0) AS n FROM ${table}`))[0][0].n);
const eventsSince = async (id: number) =>
  ((await world.sql.query<any[]>("SELECT actor, actor_role, table_name, row_id, new_row FROM audit_log WHERE id > ? AND action = 'event' ORDER BY id", [id]))[0] as Record<string, any>[]).map((e) => ({
    actor: e.actor as string | null,
    actor_role: e.actor_role as string,
    table_name: e.table_name as string,
    row_id: e.row_id as string,
    facts: (typeof e.new_row === 'string' ? JSON.parse(e.new_row) : e.new_row) as Record<string, unknown>,
  }));
const errorRowsSince = async (id: number) =>
  ((await world.sql.query<any[]>('SELECT level, code, message, request_id, user_id, detail FROM sys_error_log WHERE id > ? ORDER BY id', [id]))[0] as Record<string, any>[]).map((r) => ({
    ...r,
    detail: typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail,
  }));

/** A login with a real hash of PASSWORD (and the live session addUser makes for it). */
const person = (extra: { role?: string; active?: boolean; mustChange?: boolean; email?: string } = {}) =>
  world.addUser({ role: extra.role ?? 'staff', active: extra.active, mustChange: extra.mustChange, email: extra.email, passwordHash: HASH });

/** Asks for a link for `email` `n` times (each from an address of its own) and returns the mails that went out, in order. */
async function mailsFor(email: string, n = 1): Promise<MailMessage[]> {
  const before = outbox.sent.length;
  for (let i = 0; i < n; i++) expect((await forgot(email)).statusCode).toBe(202);
  await settle();
  return outbox.sent.slice(before);
}
/** The tokens of `n` links for a login, in the order they were asked for. */
async function tokensFor(email: string, n = 1): Promise<string[]> {
  const mails = await mailsFor(email, n);
  expect(mails.map((m) => m.to)).toEqual(Array<string>(n).fill(email));
  return mails.map(tokenOf);
}

beforeAll(async () => {
  PASSWORD = secret('Pw');
  typed.push(PASSWORD);
  HASH = await passwords.hash(PASSWORD);
  world = await makeWorld({ label: 'pwreset', routes: true, clock: createClock(() => micros), config: { mail: MAIL, logLevel: 'info' }, mailer: fakeMailer }); // info: the line of an ask over a limit is an info line
}, 120_000);

afterAll(async () => {
  await world?.close();
});

describe('POST /v1/auth/forgot-password', () => {
  it('forgot answers 202 {ok:true} for a known, an unknown and an inactive e-mail, and mails only the known active one', async () => {
    const known = await person();
    const inactive = await person({ active: false });
    const unknown = `nobody-${randomUUID().slice(0, 8)}@example.test`;
    const auditBefore = await maxId('audit_log');
    const before = outbox.attempted.length;
    const answers: LightMyRequestResponse[] = [];
    for (const email of [known.email, unknown, inactive.email]) answers.push(await forgot(email));
    for (const res of answers) {
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ ok: true });
    }
    expect(new Set(answers.map((r) => r.body)).size, 'the three answers are the same bytes').toBe(1);
    await settle();
    expect(outbox.attempted.slice(before).map((m) => m.to)).toEqual([known.email]);
    expect(await linksOf(known.userId)).toHaveLength(1);
    expect(await linksOf(inactive.userId)).toHaveLength(0);
    // the Activity Log says "asked for a reset link" only for the login that got one, with the login as the actor
    const events = await eventsSince(auditBefore);
    expect(events).toEqual([{ actor: known.userId, actor_role: 'staff', table_name: 'users', row_id: known.userId, facts: { event: 'password_reset_requested', link_id: (await linksOf(known.userId))[0].id } }]);
  });

  it('forgot matches e-mails the way login does (capitals and spaces → the same login; an accented spelling → no mail)', async () => {
    const stem = `goldpalace${randomUUID().slice(0, 6)}`;
    const u = await person({ role: 'owner', email: `${stem}@gmail.test` });
    const typedByAPerson = `  ${stem[0].toUpperCase()}${stem.slice(1)}@Gmail.TEST `;
    // the login takes this spelling ...
    expect((await login(typedByAPerson, PASSWORD)).statusCode).toBe(200);
    // ... and so does forgot: the mail goes to the login's own e-mail as it is stored
    const mails = await mailsFor(typedByAPerson);
    expect(mails.map((m) => m.to)).toEqual([u.email]);
    // an accented spelling is another text for the login (utf8mb4_unicode_ci alone would take ó for o), and for forgot: no mail, the same 202
    const accented = `${stem.replace('o', 'ó')}@gmail.test`;
    expect((await login(accented, PASSWORD)).statusCode).toBe(401);
    const res = await forgot(accented);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true });
    const before = outbox.attempted.length;
    await settle();
    expect(outbox.attempted.length).toBe(before);
    expect(await linksOf(u.userId)).toHaveLength(1);
  });

  it("the mail goes to the login's own e-mail with a link <base>#t=<43 chars>, and only sha256(token) is stored", async () => {
    const u = await person();
    const createdAt = micros;
    const [m] = await mailsFor(u.email);
    expect(m.to).toBe(u.email);
    expect(m.subject).toBe('Reset your password: Jaishri Gold Palace');
    const token = tokenOf(m);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(m.text).toMatch(new RegExp(`${LINK.source}(?![A-Za-z0-9_-])`)); // the token ends the link
    // text and HTML say the same things: whose password, the link, once within 30 minutes, ignore it if it was not you
    for (const body of [m.text, m.html]) {
      expect(body).toContain(`reset the CRM password of`);
      expect(body).toContain(u.email);
      expect(body).toContain(`${LINK_BASE}#t=${token}`);
      expect(body).toContain('works once, within 30 minutes');
      expect(body).toContain('If it was not you, ignore this mail');
      expect(body).toContain('your password stays as it is');
    }
    expect(m.html).toContain(`href="${LINK_BASE}#t=${token}"`);
    const [row] = await linksOf(u.userId);
    expect(row.token_hash).toBe(sha256(token));
    expect(row.email_at_request).toBe(u.email);
    expect(row.password_mark).toBe(sha256(HASH));
    expect(row.used_at).toBeNull();
    // made on the API's clock (it stands at `micros`; each reading adds a microsecond), and good for 30 minutes
    const made = microsOfDbTimestamp(row.created_at);
    expect(made >= createdAt && made - createdAt < MINUTE).toBe(true);
    expect(microsOfDbTimestamp(row.expires_at) - microsOfDbTimestamp(row.created_at)).toBe(30n * MINUTE);
    // the token itself is stored nowhere
    const [[stored]] = await world.sql.query<any[]>('SELECT * FROM sys_password_resets WHERE id = ?', [row.id]);
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it('the 4th ask for one e-mail in an hour and the 11th from one address answer 202 and send nothing', async () => {
    // one e-mail: three links an hour, whatever the addresses; the fourth (typed with capitals, the same e-mail) is answered the same and sends nothing
    const u = await person();
    expect((await mailsFor(u.email, 3)).map((m) => m.to)).toEqual([u.email, u.email, u.email]);
    let res = await forgot(` ${u.email.toUpperCase()}`);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true });
    let before = outbox.attempted.length;
    await settle();
    expect(outbox.attempted.length, 'the 4th ask sends nothing').toBe(before);
    expect(await linksOf(u.userId)).toHaveLength(3);
    // the refusal is told to the log (the person is not told): which limit, and neither the e-mail, nor the address, nor a token
    expect(limitLines('email'), 'one line for the e-mail limit').toHaveLength(1);
    const [byEmail] = limitLines('email');
    const { level, time, pid, hostname, reqId, ...rest } = byEmail;
    expect([level, typeof time, typeof pid, typeof hostname, typeof reqId]).toEqual([30, 'number', 'number', 'string', 'string']); // an info line, from the request's logger
    expect(rest).toEqual({ msg: LIMIT_LINE, limit: 'email' });
    expect(JSON.stringify(byEmail)).not.toContain('@');
    expect(limitLines('address'), 'no address limit was reached yet').toHaveLength(0);

    // one address: ten calls an hour, whatever the e-mails; the eleventh, for a login that would get a mail, is answered the same and sends nothing
    const address = nextAddress();
    const v = await person();
    for (let i = 0; i < 10; i++) expect((await forgot(`nobody-${i}-${randomUUID().slice(0, 6)}@example.test`, address)).statusCode).toBe(202);
    res = await forgot(v.email, address);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true });
    before = outbox.attempted.length;
    await settle();
    expect(outbox.attempted.length, 'the 11th call from one address sends nothing').toBe(before);
    expect(await linksOf(v.userId)).toHaveLength(0);
    expect(limitLines('address'), 'one line for the address limit').toHaveLength(1);
    expect(limitLines('email'), 'and no new line for the e-mail limit').toHaveLength(1);
    const lineText = JSON.stringify(limitLines('address')[0]);
    expect(lineText).not.toContain('@');
    expect(lineText).not.toContain(address);
    expect(lineText).not.toContain(v.email);
    // it was the address: the same e-mail from another address gets its mail
    expect((await mailsFor(v.email)).map((m) => m.to)).toEqual([v.email]);
    // and a call refused for its address is not counted for its e-mail (as the login counts), so one address cannot use up the asks of e-mails it names
    const w = await person();
    for (let i = 0; i < 3; i++) expect((await forgot(w.email, address)).statusCode).toBe(202);
    expect((await mailsFor(w.email, 3)).map((m) => m.to)).toEqual([w.email, w.email, w.email]);

    // an hour later both are open again
    micros += HOUR;
    expect((await mailsFor(u.email)).map((m) => m.to)).toEqual([u.email]);
    before = outbox.attempted.length;
    expect((await forgot(v.email, address)).statusCode).toBe(202);
    await settle();
    expect(outbox.attempted.slice(before).map((m) => m.to)).toEqual([v.email]);
  });

  it('no mail settings: forgot answers 503 with reason mail_not_set_up', async () => {
    const app = buildApp({ config: testConfig({ logLevel: 'silent' }) }); // mail: null and no mailer, as a server without the JV_SMTP_* variables
    await app.ready();
    try {
      expect(app.mailer).toBeNull();
      for (let i = 0; i < 12; i++) {
        const res = await app.inject({ method: 'POST', url: '/v1/auth/forgot-password', headers: { ...csrfHeaders(), 'x-real-ip': '198.51.100.7' }, payload: { email: 'someone@example.test' } });
        expect(res.statusCode).toBe(503);
        expect(errorOf(res)).toEqual({ code: 'JV_UNAVAILABLE', message: 'E-mail is not set up here. Ask the Super Admin to reset your password.', details: { reason: 'mail_not_set_up' } });
      }
    } finally {
      await app.close();
    }
  });

  it('a failed send leaves an error row and nothing else', async () => {
    const u = await person();
    const errorsBefore = await maxId('sys_error_log');
    const sentBefore = outbox.sent.length;
    const attemptedBefore = outbox.attempted.length;
    // what nodemailer rejects with when the server refuses: a code, and a message that names the address (it must go nowhere)
    outbox.failWith = Object.assign(new Error(`Can't send mail - all recipients were rejected: 550 5.1.1 <${u.email}>: no such user`), { code: 'EENVELOPE', responseCode: 550 });
    let res: LightMyRequestResponse;
    try {
      res = await forgot(u.email);
      await settle();
    } finally {
      outbox.failWith = null;
    }
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true });
    expect(outbox.attempted.length - attemptedBefore, 'the send was tried').toBe(1);
    expect(outbox.sent.length).toBe(sentBefore);
    const token = tokenOf(outbox.attempted[attemptedBefore]);
    const rows = await errorRowsSince(errorsBefore);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ level: 'error', code: 'JV_MAIL_FAILED', message: 'a password reset mail could not be sent', detail: { smtp_code: 'EENVELOPE' } });
    expect(Object.keys(rows[0].detail)).toEqual(['smtp_code']);
    const text = JSON.stringify(rows[0]);
    expect(text).not.toContain('@');
    expect(text).not.toContain(token);
    expect(text).not.toContain(sha256(token));
    expect(text).not.toContain('#t=');
    // the log says the code, and not the address or the link
    expect(world.logs.text()).toContain('EENVELOPE');
    expect(world.logs.text()).not.toContain(u.email);
    expect(world.logs.text()).not.toContain(token);
  });

  it('a failure of the work after the answer is kept in the error log and never reaches the client (the answer does not wait for it)', async () => {
    const u = await person();
    const errorsBefore = await maxId('sys_error_log');
    const attemptedBefore = outbox.attempted.length;
    // another connection holds the login's row: the link's insert waits for it (the foreign key) until the lock wait ends it (5 s, S11)
    const holder = await world.scratch.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM users WHERE id = ? FOR UPDATE', [u.userId]);
      const started = performance.now();
      const res = await forgot(u.email);
      expect(performance.now() - started, 'the answer came before the work').toBeLessThan(2000);
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ ok: true });
      await settle();
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
    }
    expect(outbox.attempted.length, 'no mail without a link').toBe(attemptedBefore);
    expect(await linksOf(u.userId)).toHaveLength(0);
    const rows = await errorRowsSince(errorsBefore);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: 'JV_BUSY', detail: { method: 'POST', route: '/v1/auth/forgot-password', reason: 'lock_wait' } });
    expect(JSON.stringify(rows[0])).not.toContain('@');
  }, 30_000);
});

describe('POST /v1/auth/reset-password', () => {
  it('reset with a good link: 200, the new password signs in, the old one does not, must_change_password 0, every session of the login ended, the link used, other open links closed, one password_reset_by_email event', async () => {
    const u = await person({ role: 'biller', mustChange: true });
    expect((await login(u.email, PASSWORD)).statusCode).toBe(200); // a second session, another browser
    const [, second] = await tokensFor(u.email, 2); // the work of two asks may run side by side: the order of the mails need not be the order of the rows
    const links = await linksOf(u.userId);
    const auditBefore = await maxId('audit_log');
    const NEW = newPassword();

    const res = await reset(second, NEW);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const row = await userRow(u.userId);
    expect(Number(row.must_change_password)).toBe(0);
    expect(await passwords.verify(NEW, row.password_hash)).toBe(true);
    const sessions = await sessionsOf(u.userId);
    expect(sessions).toHaveLength(2);
    for (const s of sessions) expect(s.revoked_at, 'every session of the login is ended').not.toBeNull();
    expect((await world.app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: u.cookie } })).statusCode).toBe(401);
    const after = await linksOf(u.userId);
    expect(after.map((l) => l.id)).toEqual(links.map((l) => l.id));
    for (const l of after) expect(l.used_at, 'the link used, the other one closed').not.toBeNull();
    expect(await eventsSince(auditBefore)).toEqual([
      { actor: u.userId, actor_role: 'biller', table_name: 'users', row_id: u.userId, facts: { event: 'password_reset_by_email', link_id: links.find((l) => l.token_hash === sha256(second))!.id, sessions_ended: 2 } },
    ]);

    const signed = await login(u.email, NEW);
    expect(signed.statusCode).toBe(200);
    expect(signed.json().user.must_change_password).toBe(false);
    expect((await login(u.email, PASSWORD)).statusCode).toBe(401);
  });

  it('asking again does not cancel the first link; using either closes the other', async () => {
    for (const use of ['first', 'second'] as const) {
      const u = await person();
      const [first, second] = await tokensFor(u.email, 2);
      const [used, other] = use === 'first' ? [first, second] : [second, first];
      expect((await reset(used, newPassword())).statusCode, `the ${use} link works`).toBe(200);
      expectBadLink(await reset(other, newPassword()), `the other link, after the ${use} was used`);
    }
  });

  it('two links of one login used at the same moment: one wins, the other is refused (the transaction checks the link again under the lock, after the hash)', async () => {
    const u = await person();
    const [first, second] = await tokensFor(u.email, 2);
    const [a, b] = [newPassword(), newPassword()];
    const answers = await Promise.all([reset(first, a), reset(second, b)]); // both pass the first read before either has hashed its password
    expect(answers.map((r) => r.statusCode).sort()).toEqual([200, 422]);
    const loser = answers.find((r) => r.statusCode === 422)!;
    expectBadLink(loser, 'the link that lost');
    const winner = answers[0].statusCode === 200 ? a : b;
    expect(await passwords.verify(winner, (await userRow(u.userId)).password_hash)).toBe(true);
  });

  it('a link is refused after 30 minutes, the second time, for an inactive login', async () => {
    // 30 minutes: a minute before the end it works, at the end it does not
    const early = await person();
    const late = await person();
    const [earlyToken] = await tokensFor(early.email);
    const [lateToken] = await tokensFor(late.email);
    const endOf = async (userId: string) => microsOfDbTimestamp((await linksOf(userId))[0].expires_at);
    micros = (await endOf(early.userId)) - MINUTE;
    expect((await reset(earlyToken, newPassword())).statusCode).toBe(200);
    micros = await endOf(late.userId); // the clock reads exactly the end of the link
    expectBadLink(await reset(lateToken, newPassword()), 'after 30 minutes');
    expect((await userRow(late.userId)).password_hash).toBe(HASH);

    // the second time
    const again = await person();
    const [token] = await tokensFor(again.email);
    expect((await reset(token, newPassword())).statusCode).toBe(200);
    const hashAfterFirst = (await userRow(again.userId)).password_hash;
    expectBadLink(await reset(token, newPassword()), 'the second time');
    expect((await userRow(again.userId)).password_hash).toBe(hashAfterFirst);

    // a login switched off after the link was made
    const off = await person();
    const [offToken] = await tokensFor(off.email);
    await world.sql.query('UPDATE users SET active = 0 WHERE id = ?', [off.userId]);
    expectBadLink(await reset(offToken, newPassword()), 'an inactive login');
    expect((await userRow(off.userId)).password_hash).toBe(HASH);
    expect((await linksOf(off.userId))[0].used_at).toBeNull();
  });

  it('a link is refused once the password or the e-mail changed (People & Roles reset, admin reset, change-password, edit e-mail)', async () => {
    // each road writes users its own way (src/super/people.ts, src/admin/routes.ts, src/auth/loginRoutes.ts); what the link sees is the stored hash or e-mail that changed
    const roads: [string, (userId: string) => Promise<unknown>][] = [
      ['People & Roles reset', (id) => world.sql.query('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', [secret('other-hash'), id])],
      ['admin reset', (id) => world.sql.query('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', [secret('admin-hash'), id])],
      ['change-password', (id) => world.sql.query('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [secret('own-hash'), id])],
      ['edit e-mail', (id) => world.sql.query('UPDATE users SET email = ? WHERE id = ?', [`moved-${randomUUID().slice(0, 8)}@example.test`, id])],
    ];
    for (const [road, change] of roads) {
      const u = await person();
      const [token] = await tokensFor(u.email);
      await change(u.userId);
      const before = await userRow(u.userId);
      expectBadLink(await reset(token, newPassword()), road);
      const after = await userRow(u.userId);
      expect(after.password_hash, road).toBe(before.password_hash);
      expect((await linksOf(u.userId))[0].used_at, road).toBeNull();
    }
  });

  it('a refused new password (9 characters, a common one, the e-mail) is 422 new_password and changes nothing', async () => {
    const local = `meera${randomUUID().slice(0, 6)}`;
    const u = await person({ email: `${local}@example.test` });
    const [token] = await tokensFor(u.email);
    const before = await userRow(u.userId);
    const auditBefore = await maxId('audit_log');
    const refused: [string, string][] = [
      ['Abcdefg9!', 'new_password must be at least 10 characters'],
      ['Password123', 'new_password is too common: choose one that is not on the list of very common passwords'],
      [`${local.toUpperCase()}-2026!`, 'new_password must not contain the part of your email before the @'],
    ];
    for (const [password, message] of refused) {
      typed.push(password);
      const res = await reset(token, password);
      expect(res.statusCode, message).toBe(422);
      expect(errorOf(res)).toEqual({ code: 'JV_INVALID_INPUT', message, details: { field: 'new_password' } });
    }
    expect(await userRow(u.userId)).toEqual(before);
    expect((await linksOf(u.userId))[0].used_at).toBeNull();
    for (const s of await sessionsOf(u.userId)) expect(s.revoked_at).toBeNull();
    expect(await eventsSince(auditBefore)).toEqual([]);
    // the link was not spent by the refusals
    expect((await reset(token, newPassword())).statusCode).toBe(200);
  });

  it('a token that was never mailed, and a body that is not the two fields, are refused', async () => {
    expectBadLink(await reset('A'.repeat(43), newPassword()), 'a made-up token');
    const extra = await world.app.inject({ method: 'POST', url: '/v1/auth/reset-password', headers: csrfHeaders(), payload: { token: 'A'.repeat(43), new_password: newPassword(), email: 'x@example.test' } });
    expect(extra.statusCode).toBe(422);
    expect(errorOf(extra).details).toEqual({ field: 'email' });
    const noCookieNeeded = await world.app.inject({ method: 'POST', url: '/v1/auth/reset-password', headers: { ...csrfHeaders(), cookie: `${SESSION_COOKIE}=not-a-ticket` }, payload: { token: 'A'.repeat(43), new_password: newPassword() } });
    expectBadLink(noCookieNeeded, 'a dead cookie changes nothing: the route is public');
  });
});

describe('what the two routes leave behind', () => {
  it('no token, hash or address appears in any event facts or error row', async () => {
    await settle();
    const tokens = outbox.attempted.map(tokenOf);
    expect(tokens.length).toBeGreaterThan(20);
    const [links] = await world.sql.query<any[]>('SELECT token_hash, password_mark, email_at_request FROM sys_password_resets');
    const [users] = await world.sql.query<any[]>('SELECT email, password_hash FROM users');
    const secrets = [
      ...tokens,
      ...tokens.map(sha256),
      ...links.flatMap((l: Record<string, string>) => [l.token_hash, l.password_mark, l.email_at_request]),
      ...users.flatMap((u: Record<string, string>) => [u.email, u.password_hash]),
      ...typed,
    ];
    const [events] = await world.sql.query<any[]>('SELECT action, old_row, new_row FROM audit_log');
    const [errors] = await world.sql.query<any[]>('SELECT message, detail FROM sys_error_log');
    expect(events.filter((e: Record<string, unknown>) => e.action === 'event').length).toBeGreaterThan(20);
    expect(errors.length).toBeGreaterThan(0);
    const places: [string, string][] = [
      ...events.map((e: Record<string, unknown>): [string, string] => ['audit_log', `${String(e.old_row)} ${String(e.new_row)}`]),
      ...errors.map((e: Record<string, unknown>): [string, string] => ['sys_error_log', `${String(e.message)} ${String(e.detail)}`]),
      ['the log', world.logs.text()],
    ];
    for (const [where, text] of places) {
      for (const s of secrets) expect(text.includes(s), `${where} holds a token, a hash, an e-mail address or a password`).toBe(false);
      if (where !== 'the log') expect(text, `${where} holds an @`).not.toContain('@');
    }
  });
});
