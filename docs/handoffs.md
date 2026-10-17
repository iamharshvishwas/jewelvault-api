# Handoffs between tasks

One heading per task; the next task reads the lines of the tasks it depends on.

## API01 Repo skeleton, lane harness, config, logging, clock
- Pick a lane for your checkout: `echo a > .lane` (untracked) or `JV_LANE=a`, then `npm run db:lane -- up a`. `npm test` then points at that lane; with no lane it still uses the old spike container on 33307. A chosen lane that is not up stops the run.
- In a test, `laneConfig()` (tests/helpers.ts) gives the lane database `jv_lane` and its ten-box user; `scripts/lane.mjs` exports `createTenBoxUser`, `laneInfo` (passwords: never print), `TEN_BOXES`. The lane database has migrations, seeds and `db/optional` (28 triggers) applied as the ten-box user. The server's global `sql_mode` is Hostinger's non-strict one: API02 must set strict per connection.
- `buildApp({ config, clock?, logStream? })` returns an unstarted Fastify app with `app.config` and `app.clock`; tests pass `testConfig()` and `logSink()` from tests/api/support.ts. A clock reading `{ micros, timestamp, date }` is one instant: take `voided_at` and `voided_on` from the same reading. Fake clocks: `createClock(() => micros)`.
- `src/config.ts` lists the variables (`CONFIG_VARIABLES`); add yours there and to `.env.example` (a test checks both). `src/logging.ts` holds the redact list.
- Build: `tsconfig.build.json` (NodeNext, rootDir `src`, so src imports end in `.js` and cannot import `scripts/*.mjs`); API02 must decide how the start-up check reaches the migration runner. `tests/api/support.ts#buildDist` compiles into `node_modules/.cache` for tests that spawn the server.
- `check:routes` only prints `printRoutes()` now; API04 replaces it with the matrix. `check:pricing` is not wired (API18).
