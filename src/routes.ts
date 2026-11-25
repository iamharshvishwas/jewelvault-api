// The application's routes: the one place buildApp() asks for them. Each task that builds routes adds its registration function here and calls it from registerRoutes(); a registration is
// route() calls and nothing else (src/permissions/route.ts), so every endpoint has an action of the permission matrix, a place on the public list or a token door (A1), and the generated test
// (tests/matrix.generated.test.ts) walks it for every caller as soon as it is registered.
//
// Registration happens when the app is built, before any request and before a database is needed: take `app.db` and `app.clock` inside a handler, never here. A test that wants the wrapper
// and the error handling without the application's routes builds the app with `routes: false`.
//
//   API05  the session routes (me, logout, change-password, activity) and the login
//   forgot password by e-mail: the two public routes forgot-password and reset-password (src/auth/resetRoutes.ts)
//   API07  /readyz (below)
//   API09  the admin door and the job routes
//   API33  the hourly tick (POST /internal/jobs/tick)
//   API11  the read side (the sync resources, the poll) ...
//   API13  the ordinary edits (designs, pieces, categories, subcategories) ...
//   FB-E1  the Order Book (X13 create_order, the edit of an order; its read is a sync resource, its photo upload the PhotoStore's)
//   access the Super Admin's own API under /v1/super: the three reads (ticks, people, roles), the four role writes and the five people writes
import type { FastifyInstance } from 'fastify';
import { registerAdminRoutes } from './admin/routes.js';
import { registerAuthRoutes } from './auth/loginRoutes.js';
import { registerResetRoutes } from './auth/resetRoutes.js';
import { registerDownloadRoutes } from './download/record.js';
import { registerEditRoutes } from './edit/routes.js';
import { registerJobRoutes } from './jobs/routes.js';
import { registerCreateBill } from './money/x01CreateBill.js';
import { registerRecordPayment } from './money/x02RecordPayment.js';
import { registerSettleFine } from './money/x03SettleFine.js';
import { registerVoidReceipt } from './money/x04VoidReceipt.js';
import { registerCancelBill } from './money/x05CancelBill.js';
import { registerCreateCustomer } from './money/x06CreateCustomer.js';
import { registerQuoteBill } from './money/x07QuoteBill.js';
import { registerAddOpeningBalance } from './money/x12AddOpeningBalance.js';
import { registerReissueBill } from './money/x10ReissueBill.js';
import { registerIssueRefund } from './money/x11IssueRefund.js';
import { registerOrderRoutes } from './orders/routes.js';
import { route } from './permissions/route.js';
import { registerPhotoRoutes } from './photos/routes.js';
import { registerReadRoutes } from './reads/routes.js';
import { registerStockRoutes } from './stock/routes.js';
import { registerSuperRoutes } from './super/routes.js';
import { registerSyncRoutes } from './sync/routes.js';

export function registerRoutes(app: FastifyInstance): void {
  // /healthz is registered by buildApp() itself, because the start-up gate (S11) names it.
  registerAuthRoutes(app);
  registerResetRoutes(app); // forgot password by e-mail: ask for a link, set a new password with it (public, no session)
  registerSyncRoutes(app);
  registerReadRoutes(app); // API12: the ledger, the daily totals, the audit log, the health lists, the dashboard line
  registerAdminRoutes(app); // API09: the admin door, only while JV_ADMIN_TOKEN_HASH is set
  registerJobRoutes(app); // API33: the hourly tick, only while JV_JOB_TOKEN_HASH is set
  registerEditRoutes(app); // API13: the ordinary edits
  registerQuoteBill(app); // API18: X7 quote_bill
  registerCreateBill(app); // API20: X1 create_bill
  registerRecordPayment(app); // API22: X2 record_payment
  registerSettleFine(app); // API24: X3 settle_fine
  registerVoidReceipt(app); // API25: X4 void_receipt
  registerCancelBill(app); // API25: X5 cancel_bill
  registerAddOpeningBalance(app); // API27: X12 add_opening_balance
  registerReissueBill(app); // API26: X10 reissue_bill
  registerIssueRefund(app); // API28: X11 issue_refund
  registerDownloadRoutes(app); // API35: the record of Download everything (B3)
  registerCreateCustomer(app); // API19: X6 create_customer
  registerStockRoutes(app); // API16: X8 create_design, X9 set_sku_status
  registerPhotoRoutes(app); // API17: the photo upload, the public photo read, the removal (and FB-E1's upload of an order's photo)
  registerOrderRoutes(app); // FB-E1: X13 create_order and the edit of an order (the Order Book)
  registerSuperRoutes(app); // access plan Tasks 12 to 14: the Super Admin's reads (ticks, people, roles), the four role writes and the five people writes under /v1/super
  // A14: /readyz says only whether the start-up check passed, {"ok":true} or {"ok":false} (503 while it has not): never why. The reason is in sys_error_log and the owner's dashboard line.
  route(app, { public: 'ready', handler: ({ app: a, reply }) => reply.code(a.startup?.ok === true ? 200 : 503).send({ ok: a.startup?.ok === true }) });
}
