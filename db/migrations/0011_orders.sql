-- 0011 the Order Book (FB-E1, FB-D8, Siddhi #13; spec section 17 "an orders table numbered from order:<YYYY>").
-- An order is a customer's request for a piece to be made: what it is (description), when it is due (delivery_date), how far it has got (status), up to 3 photos and notes. NO MONEY: an advance is
-- an ordinary receipt in the customer's ledger. order_no is ORD-<YYYY>-<4 digits> from the counter series order:<YYYY> (src/db/numbers.ts), the year of the Asia/Kolkata day the order is SAVED.
-- Nothing is deleted (S7): a cancelled order is a status. (updated_at, id) is the sync read's key (C3, D19); (status, delivery_date) is the dashboard's "due in 2 days or overdue".
-- The status words are compared as BINARY: a plain IN is case-insensitive on this collation, and the screens compare the exact words.
-- photo_ids keeps only the ids (an ordered JSON list, at most 3), as designs.photo_ids does; the bytes are in design_photos.
--
-- design_photos.order_id: the photos of an order live in design_photos, through the same PhotoStore and the same caps (P1, P2: 2 MiB, the type from the first bytes, 60 unattached photos or 100 MB).
-- design_photos.design_id is NOT NULL and a migration may only add, so it could not hold an order's photo without telling it apart from a design's: a photo uploaded for an order that exists would
-- have counted as "unattached" for ever, and could have been attached to a design. order_id is set only for an order's photo, and design_id then holds the same order id (it is the column the
-- three-photo count reads, through ix_design_photos_design). A live photo is attached when its order exists (order_id set) or its design exists (order_id null). No foreign key: the screen uploads
-- before the order exists, as for a design (D26). Added at the end of the table, with no index: an instant change on MariaDB, no copy of the photo bytes.

CREATE TABLE IF NOT EXISTS orders (
  id UUID NOT NULL,
  order_no VARCHAR(20) NOT NULL,
  customer_id UUID NOT NULL,
  description VARCHAR(2000) NOT NULL,
  delivery_date DATE NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'open',
  photo_ids JSON NOT NULL DEFAULT '[]',
  notes VARCHAR(2000) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  created_by UUID NULL,
  updated_by UUID NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_orders_no (order_no),
  KEY ix_orders_customer (customer_id),
  KEY ix_orders_updated (updated_at, id),
  KEY ix_orders_status_delivery (status, delivery_date),
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_orders_no CHECK (CHAR_LENGTH(TRIM(order_no)) >= 1),
  CONSTRAINT chk_orders_description CHECK (CHAR_LENGTH(TRIM(description)) >= 1),
  CONSTRAINT chk_orders_status CHECK (BINARY status IN ('open', 'in_progress', 'ready', 'delivered', 'cancelled')),
  CONSTRAINT chk_orders_photos CHECK (JSON_TYPE(photo_ids) = 'ARRAY' AND JSON_LENGTH(photo_ids) <= 3 AND JSON_SEARCH(photo_ids, 'one', 'data:%') IS NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE design_photos ADD COLUMN IF NOT EXISTS order_id UUID NULL;
