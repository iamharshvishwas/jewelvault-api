-- 0013 forgot password by e-mail (DESIGN.md of password-help-2026-11-26, part 2).
-- One table `sys_password_resets`: a row is one reset link that was mailed. Only HASHES are kept: token_hash is the SHA-256 (hex) of the token in the link, which lives in the mail and nowhere else,
-- and password_mark is the SHA-256 (hex) of the login's stored password hash at the moment the link was made. email_at_request is the login's e-mail at that moment. A link is good only while its
-- row is unused (used_at is NULL), not expired (expires_at) and both marks still match the login, so changing the password or the e-mail by any other road kills the links without touching that code.
-- A link is closed by setting used_at, never by a DELETE (S7). The `sys_` prefix keeps the table out of the generated audit triggers (db/optional/0910), like sys_login_attempts; it holds no secret in plain form.
-- id and user_id are UUID like sessions.id and users.id (a CHAR(36) column cannot be the child of a UUID column in MariaDB: the foreign key is refused).

CREATE TABLE IF NOT EXISTS sys_password_resets (
  id UUID NOT NULL,
  user_id UUID NOT NULL,
  token_hash CHAR(64) NOT NULL,
  email_at_request VARCHAR(254) NOT NULL,
  password_mark CHAR(64) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  expires_at DATETIME(6) NOT NULL,
  used_at DATETIME(6) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_password_resets_token (token_hash),
  KEY ix_password_resets_user (user_id, used_at),
  CONSTRAINT fk_password_resets_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
