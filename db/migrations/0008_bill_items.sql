-- 0008 bill lines (spec D12, R3 to R7). A line is a snapshot taken at sale time; it never contains the owner-only weight.
-- The database re-checks what R6 and R7 promise: a By Weight line has quantity 1, and item_total = metal + labour + piroi + other charges, to the paisa.

CREATE TABLE IF NOT EXISTS bill_items (
  id UUID NOT NULL,
  bill_id UUID NOT NULL,
  line_no SMALLINT NOT NULL,
  sku_id UUID NOT NULL,
  design_no VARCHAR(64) NOT NULL,
  sku_no VARCHAR(64) NOT NULL,
  category VARCHAR(80) NOT NULL,
  material VARCHAR(10) NOT NULL,
  purity VARCHAR(20) NOT NULL,
  selling_method VARCHAR(16) NOT NULL,
  gross_weight DECIMAL(12,3) NOT NULL,
  customer_net_weight DECIMAL(12,3) NOT NULL,
  quantity INT NOT NULL DEFAULT 1,
  metal_rate DECIMAL(12,2) NOT NULL,
  labour_rate DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  labour_amount DECIMAL(14,2) NOT NULL,
  piroi DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  other_charges DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  metal_amount DECIMAL(14,2) NOT NULL,
  fine_weight_due DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  item_total DECIMAL(14,2) NOT NULL,
  tax_rate DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  tax_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  list_metal_rate DECIMAL(12,2) NOT NULL,
  list_labour_rate DECIMAL(12,2) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_bill_items_line (bill_id, line_no),
  UNIQUE KEY uq_bill_items_sku (bill_id, sku_id),
  KEY ix_bill_items_sku (sku_id),
  KEY ix_bill_items_updated (updated_at, id),
  CONSTRAINT fk_bill_items_bill FOREIGN KEY (bill_id) REFERENCES bills (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_bill_items_sku FOREIGN KEY (sku_id) REFERENCES skus (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_bill_items_line CHECK (line_no >= 1 AND line_no <= 200),
  CONSTRAINT chk_bill_items_quantity CHECK (quantity >= 1 AND quantity <= 1000),
  CONSTRAINT chk_bill_items_material CHECK (material IN ('Gold', 'Silver')),
  CONSTRAINT chk_bill_items_method CHECK (selling_method IN ('By Weight', 'Per Piece')),
  CONSTRAINT chk_bill_items_by_weight CHECK (selling_method <> 'By Weight' OR quantity = 1),
  CONSTRAINT chk_bill_items_weights CHECK (
    gross_weight >= 0 AND gross_weight <= 100000 AND customer_net_weight >= 0 AND customer_net_weight <= 100000 AND fine_weight_due >= 0 AND fine_weight_due <= 100000
  ),
  CONSTRAINT chk_bill_items_rates CHECK (
    metal_rate >= 0 AND metal_rate <= 100000000 AND labour_rate >= 0 AND labour_rate <= 100000000
    AND list_metal_rate >= 0 AND list_metal_rate <= 100000000 AND (list_labour_rate IS NULL OR (list_labour_rate >= 0 AND list_labour_rate <= 100000000))
  ),
  CONSTRAINT chk_bill_items_amounts CHECK (
    labour_amount >= 0 AND labour_amount <= 1000000000 AND piroi >= 0 AND piroi <= 1000000000 AND other_charges >= 0 AND other_charges <= 1000000000
    AND metal_amount >= 0 AND metal_amount <= 1000000000 AND item_total >= 0 AND item_total <= 1000000000 AND tax_amount >= 0 AND tax_amount <= 1000000000
  ),
  CONSTRAINT chk_bill_items_tax_rate CHECK (tax_rate >= 0 AND tax_rate <= 100),
  CONSTRAINT chk_bill_items_total CHECK (item_total = metal_amount + labour_amount + piroi + other_charges)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
