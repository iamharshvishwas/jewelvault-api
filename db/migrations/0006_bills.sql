-- 0006 bills (spec D11, R8, K1, K6). Bills are never edited; a correction is a cancel plus a re-issue (reissue_of).
-- No API call updates a bill except cancel (status, cancel_*) and the touch of updated_at. All amounts are exact DECIMAL.
-- (id, customer_id) is UNIQUE so that receipt_allocations can use a composite foreign key and never join another customer's bill (Y4).

CREATE TABLE IF NOT EXISTS bills (
  id UUID NOT NULL,
  bill_no VARCHAR(30) NOT NULL,
  customer_id UUID NOT NULL,
  bill_date DATE NOT NULL,
  doc_type VARCHAR(16) NOT NULL DEFAULT 'estimate',
  sale_type VARCHAR(16) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'active',
  cancel_reason VARCHAR(500) NULL,
  cancelled_at DATETIME(6) NULL,
  cancelled_by UUID NULL,
  reissue_of UUID NULL,
  pricing_version SMALLINT NOT NULL DEFAULT 1,
  subtotal DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  discount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  additional_charges DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  gst_percent DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  gst_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  grand_total DECIMAL(14,2) NOT NULL,
  round_off DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  fine_weight_due DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  notes TEXT NULL,
  cash_override_reason VARCHAR(500) NULL,
  import_batch_id UUID NULL,
  request_id UUID NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  created_by UUID NULL,
  updated_by UUID NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_bills_no (bill_no),
  UNIQUE KEY uq_bills_request (request_id),
  UNIQUE KEY uq_bills_reissue (reissue_of),
  UNIQUE KEY uq_bills_id_customer (id, customer_id),
  KEY ix_bills_customer_date (customer_id, bill_date),
  KEY ix_bills_import (import_batch_id),
  KEY ix_bills_updated (updated_at, id),
  CONSTRAINT fk_bills_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_bills_reissue FOREIGN KEY (reissue_of) REFERENCES bills (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_bills_import FOREIGN KEY (import_batch_id) REFERENCES sys_import_batches (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_bills_doc_type CHECK (doc_type IN ('estimate', 'tax_invoice', 'bill_of_supply', 'opening_balance')),
  CONSTRAINT chk_bills_sale_type CHECK (sale_type IN ('Retail', 'Semi-Wholesale', 'Wholesale')),
  CONSTRAINT chk_bills_status CHECK (status IN ('active', 'cancelled')),
  CONSTRAINT chk_bills_cancel CHECK (
    ((status = 'cancelled') = (cancel_reason IS NOT NULL)) AND ((status = 'cancelled') = (cancelled_at IS NOT NULL)) AND ((status = 'cancelled') = (cancelled_by IS NOT NULL))
  ),
  CONSTRAINT chk_bills_amounts CHECK (
    subtotal >= 0 AND subtotal <= 1000000000 AND discount >= 0 AND discount <= 1000000000 AND additional_charges >= 0 AND additional_charges <= 1000000000
    AND gst_amount >= 0 AND gst_amount <= 1000000000 AND grand_total >= 0 AND grand_total <= 1000000000
  ),
  CONSTRAINT chk_bills_round_off CHECK (round_off >= -0.50 AND round_off <= 0.50),
  CONSTRAINT chk_bills_gst CHECK (gst_percent >= 0 AND gst_percent <= 100),
  CONSTRAINT chk_bills_fine CHECK (fine_weight_due >= 0 AND fine_weight_due <= 20000000),
  CONSTRAINT chk_bills_version CHECK (pricing_version >= 1),
  CONSTRAINT chk_bills_whole_rupee CHECK (doc_type <> 'estimate' OR grand_total = ROUND(grand_total, 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
