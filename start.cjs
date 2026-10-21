'use strict';
// Entry file for Hostinger. Its Node launcher (lsnode.js) loads the entry with require(), and dist/server.js is an ES module with a top-level await,
// which require() refuses (ERR_REQUIRE_ASYNC_MODULE, seen in the runtime logs on 21 Oct 2026). import() accepts it, so this file only forwards to it.
// In hPanel: Build and output settings, entry file = start.cjs.
import('./dist/server.js').catch((error) => {
  console.error('jewelvault-api could not start', error);
  process.exit(1);
});
