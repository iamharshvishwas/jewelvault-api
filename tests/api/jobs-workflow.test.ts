import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO } from './support';

// T-R04 (I8, O44): `.github/workflows/jobs.yml` is the GitHub Actions workflow that calls the hourly tick and `GET /internal/jobs/health` independently of the hPanel cron job ("it does nothing if the
// first call worked"). The curl-from-cron half and the real run of the workflow are OPS03 (hPanel and GitHub); what can be proved here is the file: it fires on a schedule, it calls both
// endpoints with the job token from the repository's Actions secret (PH06a, Harsh's), a failed answer fails the run (so GitHub e-mails the owner of the repository), the health call is made even
// when the tick failed, and no secret value is in the file or in the log.
// There is no YAML parser in the dependencies (and there must not be one for this): the checks read the text, line by line.

const FILE = path.join(REPO, '.github', 'workflows', 'jobs.yml');
const text = readFileSync(FILE, 'utf8');
const lines = text.split('\n');
const code = lines.filter((l) => !/^\s*#/.test(l)).join('\n'); // without the comment lines

describe('T-R04 the GitHub Actions workflow of the jobs (.github/workflows/jobs.yml)', () => {
  it('is plain YAML as far as can be seen: no tab, a name, an on: block, one job with steps', () => {
    expect(text).not.toMatch(/\t/);
    expect(code).toMatch(/^name: .+/m);
    expect(code).toMatch(/^on:\s*$/m);
    expect(code).toMatch(/^jobs:\s*$/m);
    expect(code.match(/^ {2}[a-z][a-z0-9_-]*:\s*$/gm)?.length ?? 0).toBeGreaterThanOrEqual(2); // `on:` is not indented; the job and the like are
    expect(code).toMatch(/^ {4}steps:\s*$/m);
  });

  it('runs on a schedule, once an hour (the minute is not 0: GitHub delays the runs of the top of the hour), and can be started by hand', () => {
    expect(code).toMatch(/^ {2}schedule:\s*$/m);
    const crons = [...code.matchAll(/^\s*- cron: ['"]([^'"]+)['"]\s*$/gm)].map((m) => m[1]);
    expect(crons.length).toBeGreaterThanOrEqual(1);
    for (const cron of crons) {
      expect(cron, 'one run an hour').toMatch(/^([1-9]|[1-5][0-9]) \* \* \* \*$/);
    }
    expect(code).toMatch(/^ {2}workflow_dispatch:/m);
  });

  it('calls the tick with POST and the health route with GET, on the API address of the repository variable, with the job token from the Actions secret as a bearer token', () => {
    expect(code).toMatch(/-X POST\b/);
    expect(code).toContain('/internal/jobs/tick');
    expect(code).toContain('/internal/jobs/health');
    expect(code).toMatch(/-H "Authorization: Bearer \$JV_JOB_TOKEN"/);
    expect(code).toMatch(/JV_JOB_TOKEN: \$\{\{ secrets\.JV_JOB_TOKEN \}\}/);
    expect(code).toMatch(/JV_API_URL: \$\{\{ vars\.JV_API_URL \}\}/);
    // the URL is built from the variable, never typed into the file
    expect(code).not.toMatch(/https?:\/\/[a-z0-9.-]+\/internal\/jobs/i);
  });

  it('a failed answer fails the run (curl -f, a time limit under the front end\'s 60 seconds), and the health call is made even when the tick failed', () => {
    const curls = code.split('\n').filter((l) => /\bcurl\b/.test(l));
    expect(curls.length).toBeGreaterThanOrEqual(2);
    for (const l of curls) {
      expect(l, l).toMatch(/\s-[a-zA-Z]*f[a-zA-Z]*\s|--fail\b/);
      expect(l, l).toMatch(/--max-time (\d+)/);
      expect(Number(/--max-time (\d+)/.exec(l)![1]), l).toBeLessThanOrEqual(60);
    }
    expect(code).toMatch(/^\s*if: always\(\)\s*$/m); // the step of the health call
    expect(code).toMatch(/^\s*run: \|\s*$/m);
    expect(code).toMatch(/set -eu/); // a failing command stops the script and fails the step
  });

  it('stops with a clear message when the secret or the address is not set, instead of calling a wrong address with an empty token', () => {
    expect(code).toMatch(/-z "\$JV_JOB_TOKEN"/);
    expect(code).toMatch(/-z "\$JV_API_URL"/);
    expect(code).toMatch(/exit 1/);
  });

  it('holds no secret: no token in the file, nothing echoed, no trace output, read-only permissions, one run at a time', () => {
    expect(code).not.toMatch(/\bset -[a-z]*x/); // set -x would print the command with the token
    expect(code).not.toMatch(/(echo|printf|cat|env|printenv)\b[^\n]*\$\{?JV_JOB_TOKEN/);
    expect(code).not.toMatch(/Bearer [A-Za-z0-9_-]{20,}/);
    expect(code).not.toMatch(/(token|secret|password|key)["']?\s*[:=]\s*["'][A-Za-z0-9+/=_.-]{16,}["']/i);
    expect(code).toMatch(/^permissions:\s*\n {2}contents: read\s*$/m);
    expect(code).toMatch(/^concurrency:\s*$/m);
    // where the token's value is used: the test of whether it is empty and the bearer header of the two curl calls, nowhere else
    for (const l of lines.filter((x) => /\$\{?JV_JOB_TOKEN/.test(x) && !/^\s*#/.test(x))) {
      expect(l, l).toMatch(/-z "\$JV_JOB_TOKEN"|-H "Authorization: Bearer \$JV_JOB_TOKEN"/);
    }
  });
});
