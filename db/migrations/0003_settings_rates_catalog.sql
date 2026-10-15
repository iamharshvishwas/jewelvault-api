-- 0003 settings, daily rates, categories (spec D3, D4, D5).
-- The seeds (D20) live in db/seeds; this file only makes the tables.

CREATE TABLE IF NOT EXISTS settings (
  setting_key VARCHAR(64) NOT NULL,
  value JSON NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  created_by UUID NULL,
  updated_by UUID NULL,
  PRIMARY KEY (setting_key),
  KEY ix_settings_updated (updated_at, setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS daily_rates (
  id UUID NOT NULL,
  material VARCHAR(10) NOT NULL,
  purity VARCHAR(20) NOT NULL,
  rate_per_gram DECIMAL(12,2) NOT NULL,
  rate_date DATE NOT NULL,
  confirmed_by UUID NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  created_by UUID NULL,
  updated_by UUID NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_daily_rates_day (rate_date, material, purity),
  KEY ix_daily_rates_updated (updated_at, id),
  CONSTRAINT chk_daily_rates_material CHECK (material IN ('Gold', 'Silver')),
  CONSTRAINT chk_daily_rates_rate CHECK (rate_per_gram > 0 AND rate_per_gram <= 100000000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS categories (
  id UUID NOT NULL,
  name VARCHAR(80) NOT NULL,
  prefix VARCHAR(12) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  created_by UUID NULL,
  updated_by UUID NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_categories_name (name),
  KEY ix_categories_updated (updated_at, id),
  CONSTRAINT chk_categories_name CHECK (CHAR_LENGTH(TRIM(name)) >= 1),
  CONSTRAINT chk_categories_prefix CHECK (BINARY prefix REGEXP '^[A-Z0-9]{2,6}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS subcategories (
  id UUID NOT NULL,
  category_id UUID NOT NULL,
  name VARCHAR(80) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  created_by UUID NULL,
  updated_by UUID NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_subcategories_name (category_id, name),
  KEY ix_subcategories_updated (updated_at, id),
  CONSTRAINT fk_subcategories_category FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_subcategories_name CHECK (CHAR_LENGTH(TRIM(name)) >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
