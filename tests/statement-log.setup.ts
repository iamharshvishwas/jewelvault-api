import { resolve } from 'node:path';
import { installStatementLog } from './api/statement-log';

// vitest setup file (vitest.config.ts): when JV_STATEMENT_LOG names a folder, every statement that code in src/ sends during the run is written there with its EXPLAIN plan (T-D11, A7).
// `npm run verify` sets it for the whole suite and `npm run check:static` judges the log. Without it this file does nothing.
const dir = process.env.JV_STATEMENT_LOG;
if (dir) installStatementLog({ dir: resolve(dir) });
