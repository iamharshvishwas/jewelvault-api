-- 0007 pieces and the owner-only weight (spec D7, D8, D9).
-- Rules NOT in the database on purpose: "net weight not above gross weight" and "net weight above 0 for a By Weight design" (O37: they run only on insert and when a weight changes,
-- never on a status change, and the second needs the design); "selling_method cannot change while the design has pieces" (needs the design). They are rules of the API.
-- sold_bill_id is indexed by its foreign key, so "the pieces of this bill" is never a table scan. There is deliberately NO unique key on it (spike finding F2):
-- "no piece on two active bills" is invariant I2, protected by the piece row lock of K2.

CREATE TABLE IF NOT EXISTS skus (
  id UUID NOT NULL,
  design_id UUID NOT NULL,
  sku_no VARCHAR(64) NOT NULL,
  barcode VARCHAR(64) NOT NULL,
  gross_weight DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  customer_net_weight DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  stones INT NOT NULL DEFAULT 0,
  stone_weight DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  kundan INT NOT NULL DEFAULT 0,
  kundan_weight DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  piroi DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  labour_retail DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  labour_semi DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  labour_wholesale DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  status VARCHAR(12) NOT NULL DEFAULT 'In Stock',
  location VARCHAR(60) NULL,
  notes TEXT NULL,
  sold_bill_id UUID NULL,
  archived_at DATETIME(6) NULL,
  import_batch_id UUID NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  created_by UUID NULL,
  updated_by UUID NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_skus_no (sku_no),
  UNIQUE KEY uq_skus_barcode (barcode),
  KEY ix_skus_design (design_id),
  KEY ix_skus_status (status),
  KEY ix_skus_sold_bill (sold_bill_id),
  KEY ix_skus_import (import_batch_id),
  KEY ix_skus_updated (updated_at, id),
  CONSTRAINT fk_skus_design FOREIGN KEY (design_id) REFERENCES designs (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_skus_sold_bill FOREIGN KEY (sold_bill_id) REFERENCES bills (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_skus_import FOREIGN KEY (import_batch_id) REFERENCES sys_import_batches (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_skus_status CHECK (status IN ('In Stock', 'Reserved', 'On Approval', 'Sold', 'Returned', 'Repair', 'Transferred', 'Missing', 'Damaged', 'Archived')),
  CONSTRAINT chk_skus_sold CHECK ((status = 'Sold') = (sold_bill_id IS NOT NULL)),
  CONSTRAINT chk_skus_archived CHECK ((status = 'Archived') = (archived_at IS NOT NULL)),
  CONSTRAINT chk_skus_weights CHECK (
    gross_weight >= 0 AND gross_weight <= 100000 AND customer_net_weight >= 0 AND customer_net_weight <= 100000
    AND stone_weight >= 0 AND stone_weight <= 100000 AND kundan_weight >= 0 AND kundan_weight <= 100000
  ),
  CONSTRAINT chk_skus_rates CHECK (
    labour_retail >= 0 AND labour_retail <= 100000000 AND labour_semi >= 0 AND labour_semi <= 100000000 AND labour_wholesale >= 0 AND labour_wholesale <= 100000000
  ),
  CONSTRAINT chk_skus_piroi CHECK (piroi >= 0 AND piroi <= 1000000000),
  CONSTRAINT chk_skus_counts CHECK (stones >= 0 AND kundan >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sku_private (
  sku_id UUID NOT NULL,
  original_net_weight DECIMAL(12,3) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  created_by UUID NULL,
  updated_by UUID NULL,
  PRIMARY KEY (sku_id),
  KEY ix_sku_private_updated (updated_at, sku_id),
  CONSTRAINT fk_sku_private_sku FOREIGN KEY (sku_id) REFERENCES skus (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_sku_private_weight CHECK (original_net_weight >= 0 AND original_net_weight <= 100000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
