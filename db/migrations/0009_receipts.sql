-- 0009 receipts and allocations (spec D13, D14, Y1 to Y10). One receipts table: money, silver received, silver settled in cash, money handed back (refund).
-- NOTE: a CHECK that evaluates to NULL PASSES, so every nullable column used in chk_receipts_kind is tested with IS NOT NULL (the first draft let a money receipt without a mode through; found by the tests).
-- There is no 'Credit' mode: an unpaid bill is the absence of a receipt (Y2). The kind decides which other columns must be set (chk_receipts_kind).
-- An allocation can join a receipt and a bill of the SAME customer only: composite foreign keys (Y4).

CREATE TABLE IF NOT EXISTS receipts (
  id UUID NOT NULL,
  customer_id UUID NOT NULL,
  kind VARCHAR(16) NOT NULL,
  mode VARCHAR(16) NULL,
  amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  fine_grams DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  silver_rate DECIMAL(12,2) NULL,
  paid_on DATE NOT NULL,
  reference VARCHAR(120) NULL,
  notes TEXT NULL,
  is_opening TINYINT(1) NOT NULL DEFAULT 0,
  cash_override_reason VARCHAR(500) NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'active',
  void_reason VARCHAR(500) NULL,
  voided_at DATETIME(6) NULL,
  voided_on DATE NULL,
  voided_by UUID NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  created_by UUID NULL,
  updated_by UUID NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_receipts_id_customer (id, customer_id),
  KEY ix_receipts_customer (customer_id, paid_on),
  KEY ix_receipts_updated (updated_at, id),
  CONSTRAINT fk_receipts_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_receipts_kind CHECK (
    (kind = 'money' AND mode IS NOT NULL AND mode IN ('Cash', 'UPI', 'Card', 'Bank Transfer', 'Other') AND amount > 0 AND fine_grams = 0 AND silver_rate IS NULL)
    OR (kind = 'refund' AND mode IS NOT NULL AND mode IN ('Cash', 'UPI', 'Card', 'Bank Transfer', 'Other') AND amount > 0 AND fine_grams = 0 AND silver_rate IS NULL AND is_opening = 0)
    OR (kind = 'fine_cash' AND mode = 'Cash' AND amount > 0 AND fine_grams > 0 AND silver_rate IS NOT NULL AND silver_rate > 0 AND is_opening = 0)
    OR (kind = 'fine_silver' AND mode IS NULL AND amount = 0 AND fine_grams > 0 AND silver_rate IS NULL)
  ),
  CONSTRAINT chk_receipts_opening CHECK (is_opening IN (0, 1) AND (is_opening = 0 OR (kind = 'money' AND mode = 'Other') OR kind = 'fine_silver')),
  CONSTRAINT chk_receipts_caps CHECK (amount <= 1000000000 AND fine_grams <= 100000 AND (silver_rate IS NULL OR silver_rate <= 100000000)),
  CONSTRAINT chk_receipts_status CHECK (status IN ('active', 'voided')),
  CONSTRAINT chk_receipts_void CHECK (
    ((status = 'voided') = (void_reason IS NOT NULL)) AND ((status = 'voided') = (voided_at IS NOT NULL)) AND ((status = 'voided') = (voided_on IS NOT NULL))
    AND ((status = 'voided') = (voided_by IS NOT NULL))
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS receipt_allocations (
  id UUID NOT NULL,
  receipt_id UUID NOT NULL,
  bill_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  fine_grams DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  released_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY ix_allocations_receipt (receipt_id, customer_id),
  KEY ix_allocations_bill (bill_id, customer_id),
  KEY ix_allocations_customer (customer_id),
  KEY ix_allocations_updated (updated_at, id),
  CONSTRAINT fk_allocations_receipt FOREIGN KEY (receipt_id, customer_id) REFERENCES receipts (id, customer_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_allocations_bill FOREIGN KEY (bill_id, customer_id) REFERENCES bills (id, customer_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_allocations_one_kind CHECK (amount >= 0 AND fine_grams >= 0 AND (amount > 0 OR fine_grams > 0) AND (amount = 0 OR fine_grams = 0)),
  CONSTRAINT chk_allocations_caps CHECK (amount <= 1000000000 AND fine_grams <= 100000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
