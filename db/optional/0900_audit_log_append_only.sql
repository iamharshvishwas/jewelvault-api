-- OPTIONAL (needs the TRIGGER privilege; Hostinger's hPanel has a "Trigger" tick box and log_bin is OFF there, so SUPER should not be needed. Proved only on the real database).
-- L2: nobody changes or deletes an audit row, not even the owner of the database. INSERT is untouched. TRUNCATE and DROP are stopped by unticking "Drop" in hPanel, not by a trigger.
-- A trigger file holds DROP TRIGGER IF EXISTS and CREATE TRIGGER only (S9: CREATE OR REPLACE is refused); DROP TRIGGER needs the Trigger box, not the Drop box.
DROP TRIGGER IF EXISTS trg_audit_log_no_update;
CREATE TRIGGER trg_audit_log_no_update BEFORE UPDATE ON audit_log FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'JV_FORBIDDEN: audit_log is append-only';
DROP TRIGGER IF EXISTS trg_audit_log_no_delete;
CREATE TRIGGER trg_audit_log_no_delete BEFORE DELETE ON audit_log FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'JV_FORBIDDEN: audit_log is append-only';
