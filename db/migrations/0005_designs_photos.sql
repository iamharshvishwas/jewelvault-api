-- 0005 designs and photos (spec D6, P1 to P4 replaced by Harsh's decision of 15 Oct 2026: photos live in MariaDB).
-- designs keeps only photo ids (an ordered JSON array, at most 3, the first is the primary one). The bytes are in design_photos; no list query may ever select them.
-- A photo is two rows with the same id: kind 'full' (longest side 1000 px, JPEG quality 72) and kind 'thumb' (320 px). Rules in settings key 'photos'.

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
  CONSTRAINT chk_designs_photos CHECK (JSON_TYPE(photo_ids) = 'ARRAY' AND JSON_LENGTH(photo_ids) <= 3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS design_photos (
  id UUID NOT NULL,
  kind VARCHAR(10) NOT NULL,
  design_id UUID NOT NULL,
  mime VARCHAR(20) NOT NULL,
  byte_size INT NOT NULL,
  sha256 VARBINARY(32) NOT NULL,
  bytes MEDIUMBLOB NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by UUID NULL,
  PRIMARY KEY (id, kind),
  KEY ix_design_photos_design (design_id),
  CONSTRAINT fk_design_photos_design FOREIGN KEY (design_id) REFERENCES designs (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_design_photos_kind CHECK (kind IN ('full', 'thumb')),
  CONSTRAINT chk_design_photos_mime CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  CONSTRAINT chk_design_photos_size CHECK (byte_size >= 1 AND byte_size <= 2097152 AND byte_size = OCTET_LENGTH(bytes)),
  CONSTRAINT chk_design_photos_hash CHECK (OCTET_LENGTH(sha256) = 32)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
