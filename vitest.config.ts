import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { laneEnv, selectedLane } from './scripts/lane.mjs';

// A lane (JV_LANE=a, or the name in the untracked file .lane) points the database tests at that lane's own container (npm run db:lane -- up a).
// With no lane the tests keep using the old spike container on port 33307. A chosen lane that is not up stops the run: a test must never fall back to somebody else's database.
// JV_LANE_NAMESPACE and JV_LANE_PORT_BASE (the sandbox of scripts/lane.mjs: jv-mariadb-<namespace>-<lane>) are read here as the lane tool reads them, so a sandbox run reaches its own container and never the real
// lane of the same name (RV2-4, tests/api/rv2b-lane-namespace.test.ts). selectedLane() only names the lane (JV_LANE or the file .lane), so only laneEnv() takes them.
const lane = selectedLane();
const sandbox = { namespace: process.env.JV_LANE_NAMESPACE ?? '', portBase: Number(process.env.JV_LANE_PORT_BASE ?? 33310) };

export default defineConfig({
  // C12, T-A14: the app's pricing unit tests (tests/pricing.test.ts, a copy of the app's tests/unit/pricing.test.ts) import the file as '@/lib/pricing'; here that name is the API's copy of the file
  resolve: { alias: { '@/lib/pricing': fileURLToPath(new URL('./src/domain/pricing.ts', import.meta.url)) } },
  test: {
    include: ['tests/**/*.test.ts'],
    // T-D11: with JV_STATEMENT_LOG=<folder> the run writes down the statements of src/ and their plans (tests/api/statement-log.ts); without it the file does nothing
    setupFiles: ['tests/statement-log.setup.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
    env: lane ? laneEnv(lane, sandbox) : {},
  },
});
