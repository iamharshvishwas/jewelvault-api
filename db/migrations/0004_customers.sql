-- 0004 customers (spec D10, K5).
-- One walk-in row: a generated column that is 1 only for the walk-in, with a UNIQUE key on it (MariaDB has no partial index; is_walkin never changes, so this key is safe, spike F2).
-- mobile: ten digits, or + and 7 to 15 digits; blank only for an imported customer (import_batch_id set) and for the walk-in (O33).
-- PAN: five capital letters, four digits, one capital letter. BINARY is needed: a plain REGEXP is case-insensitive on this collation (tested).

CREATE TABLE IF NOT EXISTS customers (
  id UUID NOT NULL,
  name VARCHAR(120) NOT NULL,
  mobile VARCHAR(20) NULL,
  customer_type VARCHAR(16) NOT NULL DEFAULT 'Retail',
  email VARCHAR(254) NULL,
  address VARCHAR(500) NULL,
  gst_number VARCHAR(20) NULL,
  pan VARCHAR(10) NULL,
  notes TEXT NULL,
  is_walkin TINYINT(1) NOT NULL DEFAULT 0,
  walkin_key TINYINT AS (IF(is_walkin = 1, 1, NULL)) PERSISTENT,
  archived_at DATETIME(6) NULL,
  import_batch_id UUID NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  created_by UUID NULL,
  updated_by UUID NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customers_walkin (walkin_key),
  KEY ix_customers_mobile (mobile),
  KEY ix_customers_import (import_batch_id),
  KEY ix_customers_updated (updated_at, id),
  CONSTRAINT fk_customers_import FOREIGN KEY (import_batch_id) REFERENCES sys_import_batches (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_customers_name CHECK (CHAR_LENGTH(TRIM(name)) >= 1),
  CONSTRAINT chk_customers_type CHECK (customer_type IN ('Retail', 'Semi-Wholesale', 'Wholesale')),
  CONSTRAINT chk_customers_mobile CHECK (mobile IS NULL OR mobile REGEXP '^([0-9]{10}|[+][0-9]{7,15})$'),
  CONSTRAINT chk_customers_mobile_required CHECK (mobile IS NOT NULL OR import_batch_id IS NOT NULL OR is_walkin = 1),
  CONSTRAINT chk_customers_pan CHECK (pan IS NULL OR BINARY pan REGEXP '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  CONSTRAINT chk_customers_walkin CHECK (is_walkin IN (0, 1) AND (is_walkin = 0 OR (pan IS NULL AND archived_at IS NULL)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
