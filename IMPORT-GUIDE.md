# Import guide (spec 6.3, IM1 to IM8)

Date: 15 October 2026 (checked against spec draft 5). Draft, not run on Hostinger. The code is `scripts/import.mjs` (library), `scripts/import-cli.mjs` (the command) and `scripts/rebalance.mjs` (Y6, shared with the API's X12). 39 tests in `tests/schema/s15-import.test.ts`, 13 in `s14-rebalance.test.ts`.

## What it does and does not do

It writes designs, pieces, customers and opening balances from a **pack** (one JSON file) into the database, in **one transaction per batch**: either everything of the batch is there afterwards or nothing is. It prints a reconciliation report (IM6). Nothing is deleted, ever (S7), so a failed or refused batch simply leaves no trace.

Not done here, on purpose:

- **Turning Siddhi's sheet (or the old browser export, IM7) into a pack.** That is a one-off script that depends on what her sheet looks like, which nobody has seen yet. The pack format below is what it has to produce.
- Old estimates and payments (not carried over unless Siddhi asks; old `Credit` payments never, O17).
- Photos (they are uploaded through the screen, P2).

## The pack

```json
{
  "batch": "siddhi-stock-and-dues-2026-11-01",
  "source_file": "stock-and-dues.xlsx",
  "cut_over": "2026-11-01",
  "customers": [
    { "ref": "row 2", "name": "Anita Sharma", "mobile": "+91 98765 43210", "customer_type": "Retail",
      "dues": "1500.50", "fine_due": "2.500", "advance": "0.00", "fine_advance": "0.000" },
    { "ref": "row 9", "name": "walk-in", "walkin": true, "dues": "40.00" }
  ],
  "designs": [
    { "design_no": "RING-00042", "name": "Floral ring", "category": "Ring", "material": "Gold", "purity": "22K", "selling_method": "By Weight",
      "pieces": [
        { "sku_no": "RING-00042-001", "barcode": "BC-R42-1", "gross_weight": "5.500", "customer_net_weight": "5.000", "original_net_weight": "4.800",
          "labour_retail": "120.00", "labour_semi": "110.00", "labour_wholesale": "100.00", "location": "Main Showroom" }
      ] }
  ]
}
```

- `batch` is the batch name: **unique**, so running the same pack twice is refused. `cut_over` is the day the opening rows are dated.
- Numbers may be text (safer) or numbers. More decimals than the column holds (money 2, weights 3), a negative number or one above the caps of S4 is **rejected**, never rounded.
- Her own `design_no`, `sku_no` and `barcode` are stored as given (trimmed, unique ignoring case, at most 64 characters). A piece without `sku_no` gets `<design_no>-<3 digits>`; without `barcode` it gets `<barcodePrefix>-<sku_no>`.
- A blank `labour_semi` becomes the average of retail and wholesale (half a paisa rounds up).
- `status` may be any of In Stock, Reserved, On Approval, Returned, Repair, Transferred, Missing, Damaged. **Sold and Archived are refused** (a sold piece needs a bill).
- `original_net_weight` (owner-only) becomes a `sku_private` row.
- Mobile numbers: spaces, dashes, brackets, a leading +91 or 0 are removed; ten digits or `+` and 7 to 15 digits are kept; a blank or invalid one is stored as empty and **listed in the report for Siddhi**.
- The walk-in (`"walkin": true`) may carry dues but never an advance (K5): such an entry is rejected as a whole.
- Opening figures: `dues` and `fine_due` become one `OB-nnnn` bill with no lines; `advance` and `fine_advance` become `is_opening` receipts. A customer with both dues and an advance gets the advance applied to the dues (Y6), so I10 holds.

## Running it (on Harsh's Mac)

The connection comes only from the environment; it is never in the repository or on the command line.

```bash
export DB_HOST=... DB_PORT=3306 DB_NAME=... DB_USER=... DB_PASSWORD=...   # typed in the shell, not saved in a file
node scripts/import-cli.mjs --pack pack.json --dry-run     # does everything, prints the report, keeps nothing
node scripts/import-cli.mjs --pack pack.json               # the real run
node scripts/import-cli.mjs --seed-counters                # IM3 on its own (the real run already does it)
```

Order (IM8): staging database first, dry run then real; production only when the report is clean and Siddhi has signed the opening balances. Imports are done when the shop is closed (O35): the counters are taken inside the transaction and the screens reload their data afterwards (`data_epoch`).

Exit code 0 = clean, 1 = refused or the report is not OK, 2 = wrong command line or missing settings.

## Reading the report

The report lists, per table, rows in the source, imported and rejected; the opening totals of the source against what was written; each customer's outstanding and advance against what the source implies (dues minus advance, never both); every rejected row with its reason; warnings (things stored as given but worth a look: a net weight above the gross weight, a By Weight piece with net weight 0, a PAN that was left out, a mobile number shared by two customers); the blank or invalid mobile numbers; and, after a real run, the result of the nightly check on the committed data. `RESULT: OK` needs: nothing rejected, no difference, totals equal, nightly check passed. Rejected rows are left out and the rest is imported; `--strict` keeps nothing when anything is rejected.

## What happens inside the transaction

1. the batch row (`sys_import_batches`, name unique) 2. customers 3. designs 4. pieces and `sku_private` 5. opening bills (numbers from the `opening` counter, `OB-0001` on; the number is the `insertId` of the counter UPDATE, RM4-6) and opening advances 6. rebalance of every customer with dues AND an advance of the same kind (`rebalance.mjs`) 7. one `audit_log` row per inserted row, no actor, role `import` (use `--audit none` if the database's own triggers write the audit, to avoid two rows) 8. `seedCounters` (IM3): `design:<prefix>`, `sku:<design_no>`, `bill:<prefix>:<year>` and `opening` continue after the largest number found, and the series' `seed_value` is raised so the nightly check (I5) leaves imported numbers alone 9. every written row gets the same fresh `updated_at` and `settings.data_epoch` moves (C4) 10. reconciliation. Then commit, `ANALYZE TABLE` for the tables that changed, and the nightly check.

Measured locally: 1,000 customers, 2,000 designs and 6,000 pieces go in in about 4 seconds (the limit of IM1 is 20 seconds per batch); a larger load is split into several packs with different batch names.
