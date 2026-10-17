import { defineConfig } from 'vitest/config';
import { laneEnv, selectedLane } from './scripts/lane.mjs';

// A lane (JV_LANE=a, or the name in the untracked file .lane) points the database tests at that lane's own container (npm run db:lane -- up a).
// With no lane the tests keep using the old spike container on port 33307. A chosen lane that is not up stops the run: a test must never fall back to somebody else's database.
const lane = selectedLane();

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
    env: lane ? laneEnv(lane) : {},
  },
});
