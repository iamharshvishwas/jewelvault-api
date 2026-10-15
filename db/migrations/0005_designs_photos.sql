-- 0005 designs and photos (spec draft 4: D6, D26, P1 to P7; photos live in MariaDB, Harsh 15 Oct 2026; copy tracking from NODE-DESIGN D-Q11).
-- designs keeps only photo ids (an ordered JSON array, at most 3, the first is the primary one). The bytes are in design_photos; no list query may ever select them.
-- A photo is two rows with the same id: kind 'full' (longest side 1000 px, JPEG quality 72) and kind 'thumb' (320 px). Rules in settings key 'photos'.
-- design_photos.design_id has NO foreign key: the screen uploads before the design exists (P2); the monthly sweep (P6) finds photos no design refers to.
-- Rows are insert-only. Removing a photo is a tombstone UPDATE (removed_at set, bytes emptied): S7, nothing is deleted. Each photo is copied once to the off-site bucket (sys_photo_copies).

CREATE TABLE IF NOT EXISTS designs (
  id UUID NOT NULL,
  design_no VARCHAR(64) NOT NULL,
  name VARCHAR(120) NULL,
  category_id UUID NOT NULL,
  subcategory_id UUID NULL,
  material VARCHAR(10) NOT NULL,
  purity VARCHAR(20) NOT NULL,
  selling_method VARCHAR(16) NOT NULL,
  description TEXT NULL,
  notes TEXT NULL,
  tags JSON NOT NULL DEFAULT '[]',
  primary_photo_id UUID NULL,
  photo_ids JSON NOT NULL DEFAULT '[]',
  archived_at DATETIME(6) NULL,
  import_batch_id UUID NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  created_by UUID NULL,
  updated_by UUID NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_designs_no (design_no),
  KEY ix_designs_category (category_id),
  KEY ix_designs_subcategory (subcategory_id),
  KEY ix_designs_import (import_batch_id),
  KEY ix_designs_updated (updated_at, id),
  CONSTRAINT fk_designs_category FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_designs_subcategory FOREIGN KEY (subcategory_id) REFERENCES subcategories (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_designs_import FOREIGN KEY (import_batch_id) REFERENCES sys_import_batches (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_designs_no CHECK (CHAR_LENGTH(TRIM(design_no)) >= 1),
  CONSTRAINT chk_designs_material CHECK (material IN ('Gold', 'Silver')),
  CONSTRAINT chk_designs_method CHECK (selling_method IN ('By Weight', 'Per Piece')),
  CONSTRAINT chk_designs_tags CHECK (JSON_TYPE(tags) = 'ARRAY'),
  CONSTRAINT chk_designs_photos CHECK (JSON_TYPE(photo_ids) = 'ARRAY' AND JSON_LENGTH(photo_ids) <= 3 AND JSON_SEARCH(photo_ids, 'one', 'data:%') IS NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS design_photos (
  id UUID NOT NULL,
  kind VARCHAR(10) NOT NULL,
  design_id UUID NOT NULL,
  mime VARCHAR(20) NOT NULL,
  byte_size INT NOT NULL,
  sha256 VARBINARY(32) NOT NULL,
  bytes MEDIUMBLOB NULL,
  removed_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by UUID NULL,
  PRIMARY KEY (id, kind),
  KEY ix_design_photos_design (design_id),
  CONSTRAINT chk_design_photos_kind CHECK (kind IN ('full', 'thumb')),
  CONSTRAINT chk_design_photos_mime CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  CONSTRAINT chk_design_photos_size CHECK (byte_size >= 1 AND byte_size <= 2097152),
  CONSTRAINT chk_design_photos_hash CHECK (OCTET_LENGTH(sha256) = 32),
  CONSTRAINT chk_design_photos_state CHECK (
    (removed_at IS NULL AND bytes IS NOT NULL AND byte_size = OCTET_LENGTH(bytes)) OR (removed_at IS NOT NULL AND bytes IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- D25 (draft 5): one row per photo object that is safely in the off-site bucket, written only after a HEAD request on the bucket confirmed the stored size (B2).
-- The nightly export leaves the bytes out; a photo never changes, so one copy is enough. NO foreign key: a removed photo keeps its copy (P3, B2).
-- The object's name is photos/<photo id>-<kind>, so no key column is needed.
CREATE TABLE IF NOT EXISTS sys_photo_copies (
  photo_id UUID NOT NULL,
  kind VARCHAR(10) NOT NULL,
  sha256 VARBINARY(32) NOT NULL,
  size INT NOT NULL,
  copied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (photo_id, kind),
  CONSTRAINT chk_photo_copies_kind CHECK (kind IN ('full', 'thumb')),
  CONSTRAINT chk_photo_copies_hash CHECK (OCTET_LENGTH(sha256) = 32),
  CONSTRAINT chk_photo_copies_size CHECK (size >= 1 AND size <= 2097152)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
