import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { logSink, secret, testConfig, toyRoutes } from './support';

async function withApp<T>(fn: (app: ReturnType<typeof buildApp>, sink: ReturnType<typeof logSink>) => Promise<T>) {
  const sink = logSink();
  const app = buildApp({ config: testConfig(), logStream: sink.stream });
  try {
    return await fn(app, sink);
  } finally {
    await app.close();
  }
}

describe('logging: cookies, authorization and password fields never reach the log', () => {
  it('writes one JSON line per event and logs requests without their headers', async () => {
    await withApp(async (app, sink) => {
      const cookie = `jv_session=${secret('c')}`;
      await app.inject({ method: 'GET', url: '/healthz', headers: { cookie, authorization: `Bearer ${secret('t')}` } });
      const lines = sink.lines();
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.some((l) => l.msg === 'request completed')).toBe(true);
      expect(sink.text()).not.toContain(cookie);
      expect(sink.text()).not.toMatch(/Bearer/);
    });
  });

  it('redacts cookie, authorization, set-cookie and proxy-authorization wherever headers are logged', async () => {
    await withApp(async (app, sink) => {
      const cookie = secret('cookie');
      const bearer = secret('bearer');
      const setCookie = secret('setcookie');
      const proxy = secret('proxy');
      toyRoutes(app).get('/echo', async (req) => {
        req.log.info({ incoming: { headers: req.headers }, outgoing: { headers: { 'set-cookie': setCookie } }, headers: { 'proxy-authorization': proxy }, ctx: { headers: { cookie } } }, 'echo');
        return { ok: true };
      });
      await app.inject({ method: 'GET', url: '/echo', headers: { cookie, authorization: bearer, 'user-agent': 'pt-test' } });
      const text = sink.text();
      for (const s of [cookie, bearer, setCookie, proxy]) expect(text, s).not.toContain(s);
      const line = sink.lines().find((l) => l.msg === 'echo')!;
      expect(line.incoming.headers.cookie).toBe('[Redacted]');
      expect(line.incoming.headers.authorization).toBe('[Redacted]');
      expect(line.outgoing.headers['set-cookie']).toBe('[Redacted]');
      expect(line.incoming.headers['user-agent']).toBe('pt-test'); // control: only the secret fields go
    });
  });

  it('redacts password fields at the top, one, two and three levels down, in every spelling the API uses', async () => {
    await withApp(async (app, sink) => {
      const values = Array.from({ length: 12 }, (_, i) => secret(`p${i}`));
      const [a, b, c, d, e, f, g, h, i, j, k, l] = values;
      toyRoutes(app).post('/echo', async (req) => {
        req.log.info(
          {
            password: a, password_hash: b, new_password: c, current_password: d,
            body: { email: 'owner@example.test', password: e, new_password: f, old_password: g },
            deep: { one: { password: h, password_hash: i }, two: { three: { password: j } } },
            camel: { newPassword: k, currentPassword: l },
          },
          'echo',
        );
        return { ok: true };
      });
      await app.inject({ method: 'POST', url: '/echo', payload: { email: 'owner@example.test', password: a } });
      const text = sink.text();
      for (const v of values) expect(text, v).not.toContain(v);
      const line = sink.lines().find((x) => x.msg === 'echo')!;
      expect(line.password).toBe('[Redacted]');
      expect(line.body.password).toBe('[Redacted]');
      expect(line.deep.two.three.password).toBe('[Redacted]');
      expect(line.body.email).toBe('owner@example.test'); // control: the e-mail stays, so the line was written and only secrets are cut
    });
  });

  it('control: without the redact list the same line would carry the secret (the test can fail)', async () => {
    const { default: pino } = await import('pino');
    const sink = logSink();
    const plain = pino(sink.stream);
    const s = secret('leak');
    plain.info({ password: s }, 'x');
    expect(sink.text()).toContain(s);
  });
});
