-- 0001 system tables: number counters, repeat-safety, import batches, job runs, error log, login throttle (spec D18, L3, L5, I8; NODE-DESIGN D-Q1).
-- Names start with sys_ so they are never mixed up with business tables. Only the API touches them.
-- Conventions of this schema (checked by tests/schema/s2-catalogue.test.ts):
--   InnoDB, utf8mb4_unicode_ci (case-insensitive unique keys); ids are native UUID; money DECIMAL(14,2), rates DECIMAL(12,2), weights DECIMAL(12,3);
--   timestamps DATETIME(6) in UTC; every foreign key is RESTRICT; no UNIQUE index on a column that changes after insert (spike finding F2);
--   no name needs quoting (key, lines, rows, order ... are reserved words in MariaDB); person columns (created_by ...) are plain UUIDs, no foreign key.

CREATE TABLE IF NOT EXISTS sys_counters (
  series VARCHAR(60) NOT NULL,
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

CREATE TABLE IF NOT EXISTS sys_login_attempts (
  id BIGINT NOT NULL AUTO_INCREMENT,
  email_hash VARBINARY(32) NOT NULL,
  ip_hash VARBINARY(32) NOT NULL,
  at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY ix_login_attempts_email (email_hash, at),
  KEY ix_login_attempts_ip (ip_hash, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
