-- 0012 roles with ticks and the Super Admin (access plan R1, R2, R3, R17; DESIGN.md of access-roles-2026-11-18).
-- One table `roles`: a role is a key, a name, a description, a switch and its ticks (a JSON list of tick keys in catalogue order, src/permissions/ticks.ts). Removing a tick is an UPDATE of
-- `ticks`, never a DELETE (S7); the generated audit trigger keeps the old and the new set. The name is unique on this collation, which ignores case, accents and trailing spaces. The key is made
-- once and never changes: a lower-case letter then up to eleven lower-case letters or hyphens (compared as BINARY, a plain REGEXP here ignores case), so that it fits users.role (12).
-- The three roles of today are seeded HERE, not in db/seeds, because fk_users_role needs them before it is added on the live database and every database applies the migrations (R17; the restore
-- tool upserts them). Owner's ticks are [] on purpose: the Owner holds every tick from the code, never from this column (R3).
-- users: is_super_admin (set only by the terminal admin door) is appended (an instant change), and chk_users_role, the list of the three role names, gives way to the foreign key fk_users_role.

CREATE TABLE IF NOT EXISTS roles (
  role_key VARCHAR(12) NOT NULL,
  name VARCHAR(40) NOT NULL,
  description VARCHAR(200) NOT NULL DEFAULT '',
  active TINYINT(1) NOT NULL DEFAULT 1,
  ticks JSON NOT NULL DEFAULT '[]',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  created_by UUID NULL,
  updated_by UUID NULL,
  PRIMARY KEY (role_key),
  UNIQUE KEY uq_roles_name (name),
  KEY ix_roles_updated (updated_at, role_key),
  CONSTRAINT chk_roles_key CHECK (BINARY role_key REGEXP '^[a-z][a-z-]{0,11}$'),
  CONSTRAINT chk_roles_name CHECK (CHAR_LENGTH(TRIM(name)) >= 1),
  CONSTRAINT chk_roles_active CHECK (active IN (0, 1)),
  CONSTRAINT chk_roles_ticks CHECK (JSON_TYPE(ticks) = 'ARRAY')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO roles (role_key, name, description, ticks) VALUES
  ('owner', 'Owner', 'Everything. This role cannot be changed.', '[]'),
  ('biller', 'Biller', 'Makes bills, takes payments and enters today''s rate.', '["customer_view","bill_view","cashbook_recent","customer_edit","bill_make","payment_receive","rate_enter","order_view","order_edit"]'),
  ('staff', 'Staff', 'Adds and edits stock.', '["stock_add","stock_edit","stock_status","category_add","order_view"]');

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_super_admin TINYINT(1) NOT NULL DEFAULT 0,
  DROP CONSTRAINT IF EXISTS chk_users_role,
  ADD FOREIGN KEY IF NOT EXISTS fk_users_role (role) REFERENCES roles (role_key) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT IF NOT EXISTS chk_users_super CHECK (is_super_admin IN (0, 1));
