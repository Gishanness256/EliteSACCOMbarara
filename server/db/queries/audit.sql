-- server/db/queries/audit.sql
-- Audit log views and verification helpers for Elite SACCO Mbarara.
-- Keep this file focused on read/verification logic for the audit trail.

-- -----------------------------------------------------------------------------
-- 1) High-severity view
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_audit_high_severity AS
SELECT
  a.id,
  a.occurred_at,
  a.officer_name,
  a.activity,
  a.particulars,
  a.category::TEXT AS category,
  a.severity::TEXT AS severity,
  a.table_name,
  a.operation::TEXT AS operation,
  a.record_id
FROM audit_log a
WHERE a.is_archived = FALSE
  AND a.severity IN ('warning', 'critical')
ORDER BY a.occurred_at DESC;

-- -----------------------------------------------------------------------------
-- 2) Helper: hash an audit row payload
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_hash_value(
  p_activity TEXT,
  p_particulars TEXT,
  p_category TEXT,
  p_severity TEXT,
  p_user_id INTEGER,
  p_table_name TEXT,
  p_record_id TEXT,
  p_session_id TEXT,
  p_ip_address INET,
  p_user_agent TEXT,
  p_occurred_at TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  payload TEXT;
BEGIN
  payload :=
      COALESCE(p_activity, '') || '|' ||
      COALESCE(p_particulars, '') || '|' ||
      COALESCE(p_category, '') || '|' ||
      COALESCE(p_severity, '') || '|' ||
      COALESCE(p_user_id::TEXT, '') || '|' ||
      COALESCE(p_table_name, '') || '|' ||
      COALESCE(p_record_id, '') || '|' ||
      COALESCE(p_session_id, '') || '|' ||
      COALESCE(p_ip_address::TEXT, '') || '|' ||
      COALESCE(p_user_agent, '') || '|' ||
      COALESCE(p_occurred_at::TEXT, '');

  RETURN encode(digest(payload, 'sha256'), 'hex');
END;
$$;

-- -----------------------------------------------------------------------------
-- 3) Rebuild hash chain for current audit_log table
--    This is useful for initial migration or after bulk import.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION rebuild_audit_chain()
RETURNS TABLE (
  updated_rows BIGINT,
  first_invalid_id BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_prev_hash TEXT := NULL;
  v_current_hash TEXT;
  v_id BIGINT;
  v_count BIGINT := 0;
BEGIN
  FOR v_id, v_current_hash IN
    SELECT
      a.id,
      audit_hash_value(
        a.activity,
        a.particulars,
        a.category::TEXT,
        a.severity::TEXT,
        a.officer_id,
        a.table_name,
        a.record_id,
        a.session_id,
        a.ip_address,
        a.user_agent,
        a.occurred_at
      )
    FROM audit_log a
    WHERE a.is_archived = FALSE
    ORDER BY a.id ASC
  LOOP
    UPDATE audit_log
       SET hash_prev = v_prev_hash,
           hash_current = v_current_hash
     WHERE id = v_id;

    v_prev_hash := v_current_hash;
    v_count := v_count + 1;
  END LOOP;

  RETURN QUERY
  SELECT v_count, NULL::BIGINT;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4) Verify hash chain integrity
--    Returns TRUE if no tampering is detected.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION verify_audit_chain()
RETURNS TABLE (
  is_valid BOOLEAN,
  checked_rows BIGINT,
  first_break_id BIGINT,
  details TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_prev_hash TEXT := NULL;
  v_current_hash TEXT;
  v_id BIGINT;
  v_count BIGINT := 0;
  v_first_break BIGINT := NULL;
BEGIN
  FOR v_id, v_current_hash IN
    SELECT a.id, a.hash_current
    FROM audit_log a
    WHERE a.is_archived = FALSE
    ORDER BY a.id ASC
  LOOP
    v_count := v_count + 1;

    IF v_prev_hash IS NOT NULL AND a.id IS NOT NULL AND v_current_hash IS NULL THEN
      v_first_break := COALESCE(v_first_break, v_id);
    END IF;

    IF v_prev_hash IS NOT NULL AND v_current_hash IS NOT NULL THEN
      IF v_current_hash <> audit_hash_value(
          (SELECT activity FROM audit_log WHERE id = v_id),
          (SELECT particulars FROM audit_log WHERE id = v_id),
          (SELECT category::TEXT FROM audit_log WHERE id = v_id),
          (SELECT severity::TEXT FROM audit_log WHERE id = v_id),
          (SELECT officer_id FROM audit_log WHERE id = v_id),
          (SELECT table_name FROM audit_log WHERE id = v_id),
          (SELECT record_id FROM audit_log WHERE id = v_id),
          (SELECT session_id FROM audit_log WHERE id = v_id),
          (SELECT ip_address FROM audit_log WHERE id = v_id),
          (SELECT user_agent FROM audit_log WHERE id = v_id),
          (SELECT occurred_at FROM audit_log WHERE id = v_id)
      ) THEN
        v_first_break := COALESCE(v_first_break, v_id);
      END IF;
    END IF;

    v_prev_hash := v_current_hash;
  END LOOP;

  IF v_first_break IS NULL THEN
    RETURN QUERY
    SELECT TRUE, v_count, NULL::BIGINT, 'Audit chain is valid.';
  ELSE
    RETURN QUERY
    SELECT FALSE, v_count, v_first_break, 'Audit chain broken or incomplete.';
  END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5) Useful read queries for the app
-- -----------------------------------------------------------------------------

-- List recent audit events filtered by category, severity, table, or officer.
-- Example:
-- SELECT *
-- FROM audit_log
-- WHERE category = 'authentication'
--   AND is_archived = FALSE
-- ORDER BY occurred_at DESC
-- LIMIT 100;

-- High severity events
-- SELECT *
-- FROM v_audit_high_severity
-- LIMIT 100;

-- Verify chain
-- SELECT *
-- FROM verify_audit_chain();

-- Rebuild hash chain if needed
-- SELECT *
-- FROM rebuild_audit_chain();
