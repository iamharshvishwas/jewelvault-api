#!/usr/bin/env node
// I8 (B), B2: `node scripts/job.js dump` is the nightly dump, started every hour by a Custom cron job in hPanel. The command is the one hPanel generates for the Node.js type of cron job
// (the app's Node 24 binary, `--env-file` of the deployment's environment, this script of the current build) with the mode word `dump` at the end. The script decides what is due, as the tick does:
// it ends at once when today's `db_dump` is ok or when it is before 02:00 in Asia/Kolkata, takes the lock jv_dump:<database>, and writes the export as one snapshot into JV_BACKUP_DIR
// (scripts/dump-job.mjs has the order of it). The whole of its configuration is the environment: DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD JV_BACKUP_DIR BACKUP_PUBLIC_KEY.
//
// The Custom command field takes at most 255 characters. If the command does not fit (a long site folder name), either put it in a small shell script in the home folder and make the cron command
// `sh /home/<user>/jv-dump.sh`, or give this script the file itself: `node scripts/job.js dump --load-env=<path of the .env file of the deployment>` (a variable that is already in the
// environment wins over the file; the flag is not called --env-file, which Node itself looks for anywhere on its command line and stops on when the file is missing). Do not add `> /dev/null 2>&1`: what this script says, and its exit code, are how a failure is seen.
//
// Exit code: 0 done, not due, already done, or another dump is in charge; 1 the backup folder cannot be used or the dump failed (recorded, the next hourly run tries again); 2 wrong command or a
// missing setting (nothing was opened).
import { DumpUsageError, runDumpJob } from './dump-job.mjs';

const USAGE = 'usage: node scripts/job.js dump [--load-env=PATH]';

function parse(argv) {
  const [mode, ...rest] = argv;
  if (mode !== 'dump') return null;
  let envFile = null;
  for (const arg of rest) {
    if (arg.startsWith('--load-env=') && arg.length > '--load-env='.length) envFile = arg.slice('--load-env='.length);
    else return null;
  }
  return { envFile };
}

async function main() {
  const parsed = parse(process.argv.slice(2));
  if (!parsed) {
    console.error(USAGE);
    return 2;
  }
  if (parsed.envFile) {
    try {
      process.loadEnvFile(parsed.envFile); // does not replace a variable that is already set
    } catch (e) {
      console.error(`dump: cannot read the env file (${e.code ?? 'error'})`);
      return 2;
    }
  }
  try {
    return (await runDumpJob({ env: process.env })).exitCode;
  } catch (e) {
    if (e instanceof DumpUsageError) {
      console.error(`dump: ${e.message}`);
      return 2;
    }
    console.error(`dump: failed: ${String(e?.message ?? e).slice(0, 300)}`);
    return 1;
  }
}

process.exitCode = await main();
// the process ends by itself when the last handle closes; if one is left open, a cron job that never ends is worse than one that is cut here
setTimeout(() => process.exit(process.exitCode), 10_000).unref();
