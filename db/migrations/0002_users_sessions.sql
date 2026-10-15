-- 0002 users and sessions (replace spec D1 profiles on auth.users; NODE-DESIGN 2.3).
-- The role lives here and nowhere else. A new user is inactive until activated. The password is stored only as a hash.

CREATE TABLE IF NOT EXISTS users (
  id UUID NOT NULL,
  email VARCHAR(254) NOT NULL,
  full_name VARCHAR(120) NOT NULL,
  role VARCHAR(12) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 0,
  password_hash VARCHAR(255) NOT NULL,
  must_change_password TINYINT(1) NOT NULL DEFAULT 0,
  last_login_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  created_by UUID NULL,
  updated_by UUID NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY ix_users_updated (updated_at, id),
  CONSTRAINT chk_users_role CHECK (role IN ('owner', 'biller', 'staff')),
  CONSTRAINT chk_users_email CHECK (LOCATE('@', email) > 1),
  CONSTRAINT chk_users_name CHECK (CHAR_LENGTH(TRIM(full_name)) >= 1),
  CONSTRAINT chk_users_flags CHECK (active IN (0, 1) AND must_change_password IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  id UUID NOT NULL,
  user_id UUID NOT NULL,
  token_hash VARBINARY(32) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  last_seen_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  expires_at DATETIME(6) NOT NULL,
  revoked_at DATETIME(6) NULL,
  user_agent VARCHAR(200) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sessions_token (token_hash),
  KEY ix_sessions_user (user_id),
  KEY ix_sessions_expires (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_sessions_token CHECK (OCTET_LENGTH(token_hash) = 32)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
