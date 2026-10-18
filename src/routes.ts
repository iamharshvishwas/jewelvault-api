// The application's routes: the one place buildApp() asks for them. Each task that builds routes adds its registration function here and calls it from registerRoutes(); a registration is
// route() calls and nothing else (src/permissions/route.ts), so every endpoint has an action of the permission matrix, a place on the public list or a token door (A1), and the generated test
// (tests/matrix.generated.test.ts) walks it for every caller as soon as it is registered.
//
// Registration happens when the app is built, before any request and before a database is needed: take `app.db` and `app.clock` inside a handler, never here. A test that wants the wrapper
// and the error handling without the application's routes builds the app with `routes: false`.
//
//   API05  the session routes (me, logout, change-password, activity) and the login
//   API07  /readyz (below)
//   API09  the admin door and the job routes
//   API11  the read side (the sync resources, the poll) ...
//   API13  the ordinary edits (designs, pieces, categories, subcategories) ...
import type { FastifyInstance } from 'fastify';
import { registerAdminRoutes } from './admin/routes.js';
import { registerAuthRoutes } from './auth/loginRoutes.js';
import { registerDownloadRoutes } from './download/record.js';
import { registerEditRoutes } from './edit/routes.js';
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
import { route } from './permissions/route.js';
import { registerPhotoRoutes } from './photos/routes.js';
import { registerReadRoutes } from './reads/routes.js';
import { registerStockRoutes } from './stock/routes.js';
import { registerSyncRoutes } from './sync/routes.js';

export function registerRoutes(app: FastifyInstance): void {
  // /healthz is registered by buildApp() itself, because the start-up gate (S11) names it.
  registerAuthRoutes(app);
  registerSyncRoutes(app);
  registerReadRoutes(app); // API12: the ledger, the daily totals, the audit log, the health lists, the dashboard line
  registerAdminRoutes(app); // API09: the admin door, only while JV_ADMIN_TOKEN_HASH is set
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
  registerPhotoRoutes(app); // API17: the photo upload, the public photo read, the owner's removal
  // A14: /readyz says only whether the start-up check passed, {"ok":true} or {"ok":false} (503 while it has not): never why. The reason is in sys_error_log and the owner's dashboard line.
  route(app, { public: 'ready', handler: ({ app: a, reply }) => reply.code(a.startup?.ok === true ? 200 : 503).send({ ok: a.startup?.ok === true }) });
}
