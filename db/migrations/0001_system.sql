-- 0001 system tables: number counters, repeat-safety, import batches, job runs, error log, login throttle (spec D18, L3, L5, I8; NODE-DESIGN D-Q1).
-- Names start with sys_ so they are never mixed up with business tables. Only the API touches them.
-- Conventions of this schema (checked by tests/schema/s2-catalogue.test.ts):
--   InnoDB, utf8mb4_unicode_ci (case-insensitive unique keys); ids are native UUID; money DECIMAL(14,2), rates DECIMAL(12,2), weights DECIMAL(12,3);
--   timestamps DATETIME(6) in UTC; every foreign key is RESTRICT; no UNIQUE index on a column that changes after insert (spike finding F2);
--   no name needs quoting (key, lines, rows, order ... are reserved words in MariaDB); person columns (created_by ...) are plain UUIDs, no foreign key.

-- series: bill:<PREFIX>:<YYYY>, opening, design:<CATEGORY PREFIX>, sku:<design_no>; a design number may be 64 characters (D6), so the series is 100 (found while writing the import).
CREATE TABLE IF NOT EXISTS sys_counters (
  series VARCHAR(100) NOT NULL,
  last_value BIGINT NOT NULL DEFAULT 0,
  seed_value BIGINT NOT NULL DEFAULT 0,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (series),
  CONSTRAINT chk_counters_values CHECK (seed_value >= 0 AND last_value >= seed_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sys_idempotency (
  request_id UUID NOT NULL,
  fn VARCHAR(40) NOT NULL,
  actor UUID NOT NULL,
  args_hash CHAR(64) NOT NULL,
  claim_token UUID NULL,
  result JSON NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (request_id),
  KEY ix_idempotency_created (created_at),
  CONSTRAINT chk_idempotency_hash CHECK (CHAR_LENGTH(args_hash) = 64)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sys_import_batches (
  id UUID NOT NULL,
  name VARCHAR(120) NOT NULL,
  source_file VARCHAR(255) NULL,
  row_counts JSON NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_import_batches_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sys_job_runs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  job VARCHAR(40) NOT NULL,
  run_date DATE NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'running',
  started_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  finished_at DATETIME(6) NULL,
  detail JSON NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_job_runs_day (job, run_date),
  CONSTRAINT chk_job_runs_status CHECK (status IN ('running', 'ok', 'failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sys_error_log (
  id BIGINT NOT NULL AUTO_INCREMENT,
  at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  level VARCHAR(10) NOT NULL,
  code VARCHAR(40) NOT NULL,
  message VARCHAR(500) NOT NULL,
  request_id UUID NULL,
  user_id UUID NULL,
  detail JSON NULL,
  PRIMARY KEY (id),
  KEY ix_error_log_at (at),
  CONSTRAINT chk_error_log_level CHECK (level IN ('debug', 'info', 'warn', 'error', 'fatal'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- D24 (draft 5): login counters UPDATED IN PLACE, never one row per attempt, so an attack on the login cannot grow the database (nothing is deleted, S7).
-- scope: email, addr or any (the slot is the first two bytes of a salted SHA-256 of the lower-cased e-mail or of the address, modulo 1,024), and audit (slot 0: the failure count of the current hour).
-- At most 2 x 1,024 + 2 rows whatever is sent; the CHECKs keep it so. Two e-mails that share a slot share a counter.
CREATE TABLE IF NOT EXISTS sys_login_attempts (
  scope VARCHAR(5) NOT NULL,
  slot SMALLINT NOT NULL,
  window_start DATETIME(6) NOT NULL,
  n INT NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, slot),
  CONSTRAINT chk_login_attempts_scope CHECK (scope IN ('email', 'addr', 'any', 'audit')),
  CONSTRAINT chk_login_attempts_slot CHECK (slot >= 0 AND slot <= 1023),
  CONSTRAINT chk_login_attempts_n CHECK (n >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
