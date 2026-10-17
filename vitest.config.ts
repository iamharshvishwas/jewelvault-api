import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { laneEnv, selectedLane } from './scripts/lane.mjs';

// A lane (JV_LANE=a, or the name in the untracked file .lane) points the database tests at that lane's own container (npm run db:lane -- up a).
// With no lane the tests keep using the old spike container on port 33307. A chosen lane that is not up stops the run: a test must never fall back to somebody else's database.
const lane = selectedLane();

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
    env: lane ? laneEnv(lane) : {},
  },
});
