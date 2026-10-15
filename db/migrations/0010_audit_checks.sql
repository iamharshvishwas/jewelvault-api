-- 0010 audit log, nightly checks, backup log (spec draft 4: D16, D17, L1, L2, I8, B2).
-- NODE-DESIGN D-Q2: the API writes the audit rows in the same transaction as the change (no trigger needed). db/optional/0900 makes audit_log append-only
-- if Hostinger's user may create triggers. check_runs and backup_runs are readable by the owner only (an API rule).
-- audit_log.action 'event' is for a login, a failed login, a password change, an admin-door call or a job run (facts in new_row); actor_role is free text (a role, import, admin-cli, job, sql).
-- backup_runs.kind: db_dump (the export, WITHOUT photo bytes), photo_copy (the once-only copy of each photo, NODE-DESIGN D-Q11), restore_drill.

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT NOT NULL AUTO_INCREMENT,
  at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  actor UUID NULL,
  actor_role VARCHAR(20) NULL,
  request_id UUID NULL,
  table_name VARCHAR(64) NOT NULL,
  row_id VARCHAR(64) NOT NULL,
  action VARCHAR(10) NOT NULL,
  old_row JSON NULL,
  new_row JSON NULL,
  PRIMARY KEY (id),
  KEY ix_audit_row (table_name, row_id),
  KEY ix_audit_at (at),
  CONSTRAINT chk_audit_action CHECK (action IN ('insert', 'update', 'event'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS check_runs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  ran_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  ok TINYINT(1) NOT NULL,
  details JSON NULL,
  PRIMARY KEY (id),
  KEY ix_check_runs_at (ran_at),
  CONSTRAINT chk_check_runs_ok CHECK (ok IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS backup_runs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  ran_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  kind VARCHAR(16) NOT NULL,
  ok TINYINT(1) NOT NULL,
  bytes BIGINT NOT NULL DEFAULT 0,
  detail JSON NULL,
  PRIMARY KEY (id),
  KEY ix_backup_runs_at (ran_at),
  CONSTRAINT chk_backup_runs_kind CHECK (kind IN ('db_dump', 'photo_copy', 'restore_drill')),
  CONSTRAINT chk_backup_runs_values CHECK (ok IN (0, 1) AND bytes >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
