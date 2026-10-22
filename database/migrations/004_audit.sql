-- ============================================================================
-- Migration: 004_audit.sql
-- Project:   Elite SACCO Mbarara — Audit log & triggers subsystem
-- Database:  PostgreSQL (>= 12)
-- Depends:   001_init.sql (audit_log, users)
--            002_loans.sql (loan_status_history)
--            003_regulatory.sql (regulatory_snapshots, regulatory_compliance_log)
-- Purpose:   Extend the audit subsystem with:
--              (a) Hash-chained audit entries (tamper-evident log)
--              (b) Generic table-level audit trigger function that captures
--                  INSERT/UPDATE/DELETE on any table as structured JSONB rows
--              (c) Audit triggers installed on every core business table
--              (d) Sensitive-field redaction (passwords, NIN, photo)
--              (e) Audit retention & archival policy metadata
--              (f) Query views for the dashboard & System Auditor screen
--            All operations are additive and idempotent.
-- Generated: 2026-10-22
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. Required extensions
-- ----------------------------------------------------------------------------
-- pgcrypto is required for digest() / gen_random_bytes() used in hash-chaining.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. New enums
-- ----------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE audit_operation AS ENUM ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE audit_severity AS ENUM ('info', 'notice', 'warning', 'critical');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE audit_category AS ENUM (
        'authentication',     -- login, logout, failed login, password reset
        'user_management',    -- user create/update/remove, role changes
        'member_management',  -- member create/update/remove
        'loan_request',       -- submit, approve, reject, hold
        'loan_disbursement',  -- disburse, write-off, restructure
        'loan_repayment',     -- record repayment, schedule changes
        'savings',            -- deposit, withdrawal, import
        'collateral',         -- add, release collateral
        'regulatory',         -- config changes, snapshots, submissions
        'data_integrity',     -- hash-chain breaks, restoration attempts
        'data_import',        -- bulk imports from CSV/Excel/PDF
        'system'              -- backups, schema changes, maintenance
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- 2. Columns added to the existing audit_log table
--    The original audit_log (from 001_init.sql) has: id, occurred_at,
--    officer_id, officer_name, officer_initials, officer_role, activity,
--    particulars, ip_address, user_agent.
--    We extend it with structured fields for hash-chaining, JSONB payload,
--    and categorization.
-- ----------------------------------------------------------------------------
ALTER TABLE audit_log
    ADD COLUMN IF NOT EXISTS category       audit_category,
    ADD COLUMN IF NOT EXISTS severity       audit_severity NOT NULL DEFAULT 'info',
    ADD COLUMN IF NOT EXISTS session_id     TEXT,                       -- web session id
    ADD COLUMN IF NOT EXISTS request_id     TEXT,                       -- per-request correlation id
    ADD COLUMN IF NOT EXISTS trace_id       TEXT,                       -- distributed trace id
    ADD COLUMN IF NOT EXISTS table_name     TEXT,
    ADD COLUMN IF NOT EXISTS operation      audit_operation,
    ADD COLUMN IF NOT EXISTS record_id      TEXT,                       -- PK of affected row (stringified)
    ADD COLUMN IF NOT EXISTS row_before     JSONB,                      -- pre-change row state
    ADD COLUMN IF NOT EXISTS row_after      JSONB,                      -- post-change row state
    ADD COLUMN IF NOT EXISTS changed_fields TEXT[],                     -- list of changed column names
    ADD COLUMN IF NOT EXISTS prev_hash      TEXT,                       -- hash of the previous audit_log row
    ADD COLUMN IF NOT EXISTS row_hash       TEXT,                       -- hash of this row's content
    ADD COLUMN IF NOT EXISTS is_archived    BOOLEAN     NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS archived_at    TIMESTAMPTZ;

-- Index the new columns for common audit queries
CREATE INDEX IF NOT EXISTS idx_audit_category    ON audit_log (category);
CREATE INDEX IF NOT EXISTS idx_audit_severity    ON audit_log (severity);
CREATE INDEX IF NOT EXISTS idx_audit_table       ON audit_log (table_name);
CREATE INDEX IF NOT EXISTS idx_audit_operation   ON audit_log (operation);
CREATE INDEX IF NOT EXISTS idx_audit_record      ON audit_log (table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_audit_session     ON audit_log (session_id);
CREATE INDEX IF NOT EXISTS idx_audit_not_archived ON audit_log (occurred_at DESC) WHERE is_archived = FALSE;
CREATE INDEX IF NOT EXISTS idx_audit_severity_critical ON audit_log (occurred_at DESC) WHERE severity = 'critical';

COMMENT ON COLUMN audit_log.category     IS 'Logical grouping of the audit event (auth, loan_request, regulatory, etc.).';
COMMENT ON COLUMN audit_log.severity     IS 'info / notice / warning / critical. critical events should alert admins.';
COMMENT ON COLUMN audit_log.prev_hash    IS 'SHA-256 hash of the previous audit_log row, forming a tamper-evident chain.';
COMMENT ON COLUMN audit_log.row_hash     IS 'SHA-256 hash of this row''s content (excludes row_hash itself).';
COMMENT ON COLUMN audit_log.row_before   IS 'Pre-change row state as JSONB. Sensitive fields are redacted.';
COMMENT ON COLUMN audit_log.row_after    IS 'Post-change row state as JSONB. Sensitive fields are redacted.';
COMMENT ON COLUMN audit_log.changed_fields IS 'Array of column names whose values changed between row_before and row_after.';

-- ----------------------------------------------------------------------------
-- 3. Hash-chaining infrastructure
--    Each new audit_log row gets prev_hash = previous row's row_hash, and
--    row_hash = SHA-256 of (occurred_at || officer_id || activity || particulars
--                            || table_name || record_id || row_before || row_after
--                            || prev_hash).
--    A break in the chain signals tampering.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION compute_audit_row_hash(audit_log)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT encode(
        digest(
            COALESCE($1.occurred_at::TEXT, '')     || '|' ||
            COALESCE($1.officer_id::TEXT, '')      || '|' ||
            COALESCE($1.officer_name, '')          || '|' ||
            COALESCE($1.activity, '')              || '|' ||
            COALESCE($1.particulars, '')           || '|' ||
            COALESCE($1.table_name, '')            || '|' ||
            COALESCE($1.operation::TEXT, '')       || '|' ||
            COALESCE($1.record_id, '')             || '|' ||
            COALESCE($1.row_before::TEXT, '')      || '|' ||
            COALESCE($1.row_after::TEXT, '')       || '|' ||
            COALESCE($1.prev_hash, ''),
            'sha256'
        ),
        'hex'
    );
$$;

COMMENT ON FUNCTION compute_audit_row_hash IS
    'Computes the SHA-256 hash of an audit_log row''s content. The hash excludes the row_hash column itself, so it forms a tamper-evident chain when combined with prev_hash.';

-- Trigger: set prev_hash and row_hash on every INSERT
CREATE OR REPLACE FUNCTION trg_audit_log_chain()
RETURNS TRIGGER AS $$
DECLARE
    v_prev_hash TEXT;
BEGIN
    -- Look up the most recent row_hash
    SELECT row_hash INTO v_prev_hash
      FROM audit_log
     WHERE is_archived = FALSE
     ORDER BY id DESC
     LIMIT 1;

    NEW.prev_hash := v_prev_hash;
    NEW.row_hash  := compute_audit_row_hash(NEW);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_before_insert ON audit_log;
CREATE TRIGGER trg_audit_log_before_insert
    BEFORE INSERT ON audit_log
    FOR EACH ROW EXECUTE FUNCTION trg_audit_log_chain();

-- Block direct UPDATE and DELETE of audit_log rows (append-only policy).
-- Only the archival function may flip is_archived.
CREATE OR REPLACE FUNCTION trg_audit_log_no_modify()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only. Direct UPDATE/DELETE/TRUNCATE are forbidden. Use archive_audit_log() instead.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_block_update ON audit_log;
CREATE TRIGGER trg_audit_log_block_update
    BEFORE UPDATE ON audit_log
    FOR EACH ROW
    WHEN (NEW.is_archived IS NOT DISTINCT FROM OLD.is_archived
          AND NEW.row_hash IS NOT DISTINCT FROM OLD.row_hash)
    -- Allow only the archive function to set is_archived by bypassing this trigger
    -- via a session-local setting.
    EXECUTE FUNCTION trg_audit_log_no_modify();

DROP TRIGGER IF EXISTS trg_audit_log_block_delete ON audit_log;
CREATE TRIGGER trg_audit_log_block_delete
    BEFORE DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION trg_audit_log_no_modify();

DROP TRIGGER IF EXISTS trg_audit_log_block_truncate ON audit_log;
CREATE TRIGGER trg_audit_log_block_truncate
    BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION trg_audit_log_no_modify();

COMMENT ON FUNCTION trg_audit_log_no_modify IS 'Enforces the append-only policy on audit_log. To mark rows archived (e.g. for cold storage), use archive_audit_log() instead of direct UPDATEs.';

-- ----------------------------------------------------------------------------
-- 4. Hash-chain verification function
--    Walks the audit_log table, recomputes each row_hash from the stored
--    content, and reports the first row where the chain is broken.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION verify_audit_chain(
    p_start_id BIGINT DEFAULT NULL,
    p_end_id   BIGINT DEFAULT NULL
)
RETURNS TABLE(
    is_valid       BOOLEAN,
    broken_at_id   BIGINT,
    broken_at_time TIMESTAMPTZ,
    expected_hash  TEXT,
    actual_hash    TEXT,
    rows_checked   BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_row         audit_log%ROWTYPE;
    v_prev_hash   TEXT := NULL;
    v_expected    TEXT;
    v_count       BIGINT := 0;
    v_broken_id   BIGINT := NULL;
    v_broken_time TIMESTAMPTZ;
    v_broken_expected TEXT;
    v_broken_actual   TEXT;
BEGIN
    FOR v_row IN
        SELECT * FROM audit_log
         WHERE (p_start_id IS NULL OR id >= p_start_id)
           AND (p_end_id   IS NULL OR id <= p_end_id)
           AND is_archived = FALSE
         ORDER BY id ASC
    LOOP
        v_count := v_count + 1;

        -- Check that prev_hash matches the previous row's row_hash
        IF v_prev_hash IS NOT NULL AND v_row.prev_hash IS DISTINCT FROM v_prev_hash THEN
            v_broken_id := v_row.id;
            v_broken_time := v_row.occurred_at;
            v_broken_expected := v_prev_hash;
            v_broken_actual := v_row.prev_hash;
            RETURN QUERY SELECT FALSE, v_broken_id, v_broken_time,
                                v_broken_expected, v_broken_actual, v_count;
            RETURN;
        END IF;

        -- Recompute row_hash and compare
        v_expected := compute_audit_row_hash(v_row);
        IF v_row.row_hash IS DISTINCT FROM v_expected THEN
            v_broken_id := v_row.id;
            v_broken_time := v_row.occurred_at;
            v_broken_expected := v_expected;
            v_broken_actual := v_row.row_hash;
            RETURN QUERY SELECT FALSE, v_broken_id, v_broken_time,
                                v_broken_expected, v_broken_actual, v_count;
            RETURN;
        END IF;

        v_prev_hash := v_row.row_hash;
    END LOOP;

    RETURN QUERY SELECT TRUE, NULL::BIGINT, NULL::TIMESTAMPTZ,
                        NULL::TEXT, NULL::TEXT, v_count;
    RETURN;
END;
$$;

COMMENT ON FUNCTION verify_audit_chain IS
    'Verifies the audit_log hash chain. Returns is_valid=FALSE with the first broken row id, time, expected vs actual hash, and rows checked. Returns is_valid=TRUE if the entire chain is intact.';

-- ----------------------------------------------------------------------------
-- 5. Archival function
--    Marks old audit_log rows as archived (eligible for cold storage / export
--    to CSV). Does NOT delete rows. Bypasses the no-modify trigger via a
--    session-local setting.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION archive_audit_log(
    p_before_date   DATE,
    p_archived_by   BIGINT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
    v_count BIGINT;
BEGIN
    -- Allow the UPDATE by setting a session flag; the no-modify trigger
    -- checks this flag and permits the operation.
    PERFORM set_config('app.audit_archival_in_progress', 'true', false);

    UPDATE audit_log
       SET is_archived = TRUE,
           archived_at = NOW()
     WHERE occurred_at < p_before_date
       AND is_archived = FALSE;

    GET DIAGNOSTICS v_count = ROW_COUNT;

    -- Log the archival event itself
    INSERT INTO audit_log (
        occurred_at, officer_id, officer_name, activity, particulars,
        category, severity, table_name, operation
    ) VALUES (
        NOW(), p_archived_by,
        COALESCE((SELECT name FROM users WHERE id = p_archived_by), 'system'),
        'Audit log archived',
        'Archived ' || v_count || ' rows older than ' || p_before_date::TEXT,
        'system', 'notice', 'audit_log', 'UPDATE'
    );

    PERFORM set_config('app.audit_archival_in_progress', 'false', false);

    RETURN v_count;
END;
$$;

COMMENT ON FUNCTION archive_audit_log IS
    'Marks audit_log rows older than the given date as archived (eligible for cold storage). Returns the number of rows archived. The archival event itself is logged.';

-- Update the no-modify trigger to honor the session flag set by archive_audit_log
CREATE OR REPLACE FUNCTION trg_audit_log_no_modify()
RETURNS TRIGGER AS $$
DECLARE
    v_in_progress TEXT;
BEGIN
    v_in_progress := current_setting('app.audit_archival_in_progress', true);
    IF v_in_progress = 'true' THEN
        IF TG_OP = 'UPDATE' THEN
            -- Only allow setting is_archived and archived_at
            IF NEW.is_archived = TRUE AND OLD.is_archived = FALSE
               AND NEW.row_hash IS NOT DISTINCT FROM OLD.row_hash THEN
                RETURN NEW;
            END IF;
        END IF;
    END IF;

    RAISE EXCEPTION 'audit_log is append-only. Direct UPDATE/DELETE/TRUNCATE are forbidden. Use archive_audit_log() instead.';
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 6. Sensitive-field redaction
--    When row_before / row_after are populated, certain columns must never
--    be persisted in plaintext: password_hash, photo (base64), NIN.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION redact_sensitive_fields(
    p_row       JSONB,
    p_table     TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_result JSONB := p_row;
    v_sensitive TEXT[];
BEGIN
    v_sensitive := CASE p_table
        WHEN 'users'        THEN ARRAY['password_hash']::TEXT[]
        WHEN 'members'      THEN ARRAY['photo', 'nin']::TEXT[]
        WHEN 'non_members'  THEN ARRAY['nin']::TEXT[]
        WHEN 'loan_guarantors' THEN ARRAY['nin']::TEXT[]
        ELSE ARRAY[]::TEXT[]
    END;

    IF v_sensitive = '{}' THEN
        RETURN p_row;
    END IF;

    FOR i IN 1..array_length(v_sensitive, 1) LOOP
        IF v_result ? v_sensitive[i] THEN
            v_result := jsonb_set(
                v_result,
                ARRAY[v_sensitive[i]],
                to_jsonb('[REDACTED]'::TEXT)
            );
        END IF;
    END LOOP;

    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION redact_sensitive_fields IS
    'Replaces password_hash, photo and nin values with [REDACTED] in audit row snapshots.';

-- ----------------------------------------------------------------------------
-- 7. Generic audit trigger function
--    Install on any table to capture INSERT/UPDATE/DELETE as structured
--    audit_log rows. Usage:
--        CREATE TRIGGER trg_<table>_audit
--            AFTER INSERT OR UPDATE OR DELETE ON <table>
--            FOR EACH ROW EXECUTE FUNCTION audit_table_trigger();
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_table_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_row_before   JSONB := NULL;
    v_row_after    JSONB := NULL;
    v_changed      TEXT[];
    v_pk_cols      TEXT[];
    v_record_id    TEXT;
    v_pk_val       TEXT;
    v_officer_id   BIGINT;
    v_officer_name TEXT;
    v_officer_ini  TEXT;
    v_officer_role TEXT;
    v_session_id   TEXT;
    v_activity     TEXT;
    v_category     audit_category;
    v_severity     audit_severity := 'info';
BEGIN
    -- Determine the operation
    IF TG_OP = 'INSERT' THEN
        v_row_after  := to_jsonb(NEW);
        v_row_before := NULL;
        v_changed    := ARRAY[]::TEXT[];
    ELSIF TG_OP = 'Update' THEN
        v_row_before := to_jsonb(OLD);
        v_row_after  := to_jsonb(NEW);
        -- Compute changed field names (excluding audit-only columns)
        SELECT COALESCE(array_agg(key), ARRAY[]::TEXT[]) INTO v_changed
          FROM (
            SELECT key
              FROM jsonb_object_keys(v_row_after) AS key
             WHERE v_row_after->key IS DISTINCT FROM v_row_before->key
               AND key NOT IN ('updated_at')
          ) t;
    ELSIF TG_OP = 'Delete' THEN
        v_row_before := to_jsonb(OLD);
        v_row_after  := NULL;
        v_changed    := ARRAY[]::TEXT[];
    END IF;

    -- Redact sensitive fields
    v_row_before := redact_sensitive_fields(v_row_before, TG_TABLE_NAME);
    v_row_after  := redact_sensitive_fields(v_row_after,  TG_TABLE_NAME);

    -- Determine the primary key value (stringified)
    -- First, try to use the 'id' column; fall back to the first column.
    v_record_id := CASE
        WHEN v_row_after  ? 'id' THEN (v_row_after ->> 'id')
        WHEN v_row_before ? 'id' THEN (v_row_before ->> 'id')
        ELSE COALESCE(
                 (SELECT string_agg(value->>'value', ',')
                  FROM jsonb_array_elements(
                       (SELECT jsonb_agg(jsonb_build_object('value', v))
                          FROM (SELECT to_jsonb(OLD) AS v) s)
                  )),
                 'unknown'
             )
    END;

    -- Resolve the acting user from session settings
    v_officer_id   := NULLIF(current_setting('app.current_user_id',     true), '')::BIGINT;
    v_session_id   := NULLIF(current_setting('app.session_id',          true), '');
    IF v_officer_id IS NOT NULL THEN
        SELECT name, initials, role::TEXT
          INTO v_officer_name, v_officer_ini, v_officer_role
          FROM users WHERE id = v_officer_id;
    END IF;

    -- Build the activity description and categorize
    v_activity  := TG_OP || ' on ' || TG_TABLE_NAME;
    v_category  := CASE TG_TABLE_NAME
        WHEN 'users'                   THEN 'user_management'::audit_category
        WHEN 'role_permissions'        THEN 'user_management'::audit_category
        WHEN 'members'                 THEN 'member_management'::audit_category
        WHEN 'non_members'             THEN 'member_management'::audit_category
        WHEN 'loan_requests'           THEN 'loan_request'::audit_category
        WHEN 'loans'                   THEN 'loan_disbursement'::audit_category
        WHEN 'loan_repayments'         THEN 'loan_repayment'::audit_category
        WHEN 'loan_schedule'           THEN 'loan_repayment'::audit_category
        WHEN 'loan_collateral'         THEN 'collateral'::audit_category
        WHEN 'loan_guarantors'         THEN 'collateral'::audit_category
        WHEN 'loan_fees'               THEN 'loan_disbursement'::audit_category
        WHEN 'loan_write_offs'         THEN 'loan_disbursement'::audit_category
        WHEN 'loan_status_history'     THEN 'loan_request'::audit_category
        WHEN 'savings_transactions'    THEN 'savings'::audit_category
        WHEN 'regulatory_config'       THEN 'regulatory'::audit_category
        WHEN 'regulatory_inputs'       THEN 'regulatory'::audit_category
        WHEN 'regulatory_snapshots'    THEN 'regulatory'::audit_category
        WHEN 'regulatory_compliance_log' THEN 'regulatory'::audit_category
        WHEN 'regulatory_provision_rates' THEN 'regulatory'::audit_category
        WHEN 'regulatory_benchmarks'   THEN 'regulatory'::audit_category
        WHEN 'loan_categories'         THEN 'system'::audit_category
        WHEN 'permissions'             THEN 'system'::audit_category
        ELSE 'system'::audit_category
    END;

    -- Escalate severity for high-impact operations
    IF TG_TABLE_NAME = 'users' AND TG_OP IN ('DELETE', 'UPDATE') THEN
        v_severity := 'warning';
    ELSIF TG_TABLE_NAME = 'regulatory_config' THEN
        v_severity := 'notice';
    ELSIF TG_TABLE_NAME = 'loan_write_offs' AND TG_OP = 'INSERT' THEN
        v_severity := 'warning';
    ELSIF TG_TABLE_NAME = 'audit_log' THEN
        -- The audit_log triggers itself fire on the chain function's INSERT;
        -- those are info. Direct modification is blocked elsewhere.
        v_severity := 'info';
    END IF;

    INSERT INTO audit_log (
        occurred_at,
        officer_id, officer_name, officer_initials, officer_role,
        activity, particulars,
        category, severity,
        session_id,
        table_name, operation, record_id,
        row_before, row_after, changed_fields
    ) VALUES (
        NOW(),
        v_officer_id, v_officer_name, v_officer_ini, v_officer_role,
        v_activity,
        COALESCE(
            v_activity ||
            COALESCE(' #' || v_record_id, ''),
            v_activity
        ),
        v_category, v_severity,
        v_session_id,
        TG_TABLE_NAME, TG_OP::audit_operation, v_record_id,
        v_row_before, v_row_after, v_changed
    );

    RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION audit_table_trigger IS
    'Generic AFTER INSERT/UPDATE/DELETE trigger that writes a structured audit_log row for the change. Sensitive fields (password_hash, photo, nin) are redacted.';

-- ----------------------------------------------------------------------------
-- 8. Install audit triggers on every core business table
--    Excluded: audit_log itself (handled by the chain trigger), and
--    internal helper tables that don't hold business data.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
    t TEXT;
    v_count INTEGER := 0;
BEGIN
    FOR t IN SELECT unnest(ARRAY[
        'users',
        'role_permissions',
        'permissions',
        'loan_categories',
        'members',
        'non_members',
        'savings_transactions',
        'loan_requests',
        'loans',
        'loan_repayments',
        'loan_schedule',
        'loan_collateral',
        'loan_guarantors',
        'loan_fees',
        'loan_write_offs',
        'loan_status_history',
        'regulatory_config',
        'regulatory_inputs',
        'regulatory_provision_rates',
        'regulatory_benchmarks',
        'regulatory_snapshots',
        'regulatory_snapshot_lines',
        'regulatory_compliance_log'
    ]::TEXT[])
    LOOP
        BEGIN
            EXECUTE format(
                'DROP TRIGGER IF EXISTS trg_%I_audit ON %I;
                 CREATE TRIGGER trg_%I_audit
                     AFTER INSERT OR UPDATE OR DELETE ON %I
                     FOR EACH ROW EXECUTE FUNCTION audit_table_trigger();',
                t, t, t, t
            );
            v_count := v_count + 1;
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'Could not install audit trigger on %: %', t, SQLERRM;
        END;
    END LOOP;
    RAISE NOTICE 'Installed audit triggers on % tables.', v_count;
END $$;

-- ----------------------------------------------------------------------------
-- 9. Convenience logging function for application-layer audit events
--    Use this from API code to log business events that aren't tied to a
--    single table row (e.g. "User logged in", "Generated weekly report",
--    "Imported 47 savings transactions from CSV").
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION log_audit_event(
    p_activity       TEXT,
    p_particulars    TEXT DEFAULT NULL,
    p_category       audit_category DEFAULT 'system'::audit_category,
    p_severity       audit_severity DEFAULT 'info'::audit_severity,
    p_officer_id     BIGINT DEFAULT NULL,
    p_table_name     TEXT DEFAULT NULL,
    p_record_id      TEXT DEFAULT NULL,
    p_session_id     TEXT DEFAULT NULL,
    p_ip_address     INET DEFAULT NULL,
    p_user_agent     TEXT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
    v_id          BIGINT;
    v_officer_name TEXT;
    v_officer_ini TEXT;
    v_officer_role TEXT;
BEGIN
    IF p_officer_id IS NOT NULL THEN
        SELECT name, initials, role::TEXT
          INTO v_officer_name, v_officer_ini, v_officer_role
          FROM users WHERE id = p_officer_id;
    END IF;

    INSERT INTO audit_log (
        occurred_at,
        officer_id, officer_name, officer_initials, officer_role,
        activity, particulars,
        category, severity,
        session_id,
        table_name, record_id,
        ip_address, user_agent
    ) VALUES (
        NOW(),
        p_officer_id, v_officer_name, v_officer_ini, v_officer_role,
        p_activity, p_particulars,
        p_category, p_severity,
        p_session_id,
        p_table_name, p_record_id,
        p_ip_address, p_user_agent
    )
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION log_audit_event IS
    'Application-layer audit logging. Use from API code for events not tied to a single table change (login, report generation, bulk imports, etc.).';

-- ----------------------------------------------------------------------------
-- 10. Audit retention policy metadata
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_retention_policy (
    id                   SMALLSERIAL PRIMARY KEY,
    category             audit_category NOT NULL UNIQUE,
    retention_days       INTEGER NOT NULL DEFAULT 2555,    -- 7 years default
    archive_after_days   INTEGER NOT NULL DEFAULT 365,     -- mark archived after 1 year
    auto_archive         BOOLEAN NOT NULL DEFAULT FALSE,   -- off by default; enable per category
    notes                TEXT,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by           BIGINT REFERENCES users (id) ON DELETE SET NULL
);

-- Seed default retention policies for each category
INSERT INTO audit_retention_policy (category, retention_days, archive_after_days, auto_archive, notes)
SELECT c, 2555, 365, FALSE,
       CASE c
           WHEN 'authentication'::audit_category  THEN 'User login/logout events. Default: 7 years retention, archive after 1 year.'
           WHEN 'data_integrity'::audit_category  THEN 'Hash-chain breaks and restoration attempts. Never auto-archive.'
           WHEN 'regulatory'::audit_category      THEN 'Regulatory config & snapshots. Retain for full regulator inspection window.'
           ELSE 'Default 7-year retention per SACCO prudential guidelines.'
       END
FROM (VALUES
    ('authentication'::audit_category),
    ('user_management'::audit_category),
    ('member_management'::audit_category),
    ('loan_request'::audit_category),
    ('loan_disbursement'::audit_category),
    ('loan_repayment'::audit_category),
    ('savings'::audit_category),
    ('collateral'::audit_category),
    ('regulatory'::audit_category),
    ('data_integrity'::audit_category),
    ('data_import'::audit_category),
    ('system'::audit_category)
) AS t(c)
ON CONFLICT (category) DO NOTHING;

-- Special case: data_integrity events should never be auto-archived
UPDATE audit_retention_policy
   SET auto_archive = FALSE,
       retention_days = 99999,        -- effectively forever
       notes = 'Hash-chain breaks and restoration attempts. Never auto-archive.'
 WHERE category = 'data_integrity'::audit_category;

CREATE INDEX IF NOT EXISTS idx_retention_auto_archive
    ON audit_retention_policy (auto_archive) WHERE auto_archive = TRUE;

-- ----------------------------------------------------------------------------
-- 11. Scheduled archival job function
--     Call this from a cron / pgAgent job to auto-archive old entries per the
--     retention policy.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION run_audit_archival_job()
RETURNS TABLE(category audit_category, rows_archived BIGINT)
LANGUAGE plpgsql
AS $$
DECLARE
    v_cat       audit_category;
    v_after     INTEGER;
    v_cutoff    DATE;
    v_count     BIGINT;
BEGIN
    FOR v_cat, v_after IN
        SELECT category, archive_after_days
          FROM audit_retention_policy
         WHERE auto_archive = TRUE
    LOOP
        v_cutoff := CURRENT_DATE - v_after;
        v_count  := archive_audit_log(v_cutoff, NULL);
        IF v_count > 0 THEN
            RETURN QUERY SELECT v_cat, v_count;
        END IF;
    END LOOP;
    RETURN;
END;
$$;

COMMENT ON FUNCTION run_audit_archival_job IS
    'Cron-friendly function that archives audit_log rows older than each category''s archive_after_days threshold, for categories with auto_archive=TRUE.';

-- ----------------------------------------------------------------------------
-- 12. Reporting views
-- ----------------------------------------------------------------------------

-- (a) v_audit_recent — recent activity for the dashboard widget
CREATE OR REPLACE VIEW v_audit_recent AS
SELECT
    id,
    occurred_at,
    officer_name,
    officer_initials,
    officer_role,
    activity,
    particulars,
    category,
    severity,
    table_name,
    operation,
    record_id
FROM audit_log
WHERE is_archived = FALSE
ORDER BY occurred_at DESC
LIMIT 500;

COMMENT ON VIEW v_audit_recent IS 'Last 500 audit events (non-archived) for the dashboard widget.';

-- (b) v_audit_by_category_summary — counts by category over a rolling window
CREATE OR REPLACE VIEW v_audit_by_category_summary AS
SELECT
    category,
    COUNT(*)                                              AS total_events,
    COUNT(*) FILTER (WHERE occurred_at >= NOW() - INTERVAL '24 hours')  AS last_24h,
    COUNT(*) FILTER (WHERE occurred_at >= NOW() - INTERVAL '7 days')    AS last_7d,
    COUNT(*) FILTER (WHERE occurred_at >= NOW() - INTERVAL '30 days')   AS last_30d,
    COUNT(*) FILTER (WHERE severity = 'critical')                       AS critical_count,
    COUNT(*) FILTER (WHERE severity = 'warning')                        AS warning_count,
    MAX(occurred_at)                                                     AS last_event_at
FROM audit_log
WHERE is_archived = FALSE
GROUP BY category
ORDER BY total_events DESC;

COMMENT ON VIEW v_audit_by_category_summary IS 'Rolling counts by audit category — useful for the System Auditor dashboard.';

-- (c) v_audit_by_officer — activity per user
CREATE OR REPLACE VIEW v_audit_by_officer AS
SELECT
    officer_id,
    officer_name,
    officer_role,
    COUNT(*)                                                       AS total_events,
    COUNT(*) FILTER (WHERE category = 'authentication')           AS auth_events,
    COUNT(*) FILTER (WHERE category IN ('loan_request','loan_disbursement','loan_repayment')) AS loan_events,
    COUNT(*) FILTER (WHERE category = 'savings')                  AS savings_events,
    COUNT(*) FILTER (WHERE category = 'regulatory')               AS regulatory_events,
    COUNT(*) FILTER (WHERE severity IN ('critical','warning'))    AS high_severity_events,
    MIN(occurred_at)                                               AS first_event_at,
    MAX(occurred_at)                                               AS last_event_at
FROM audit_log
WHERE is_archived = FALSE
GROUP BY officer_id, officer_name, officer_role
ORDER BY total_events DESC;

COMMENT ON VIEW v_audit_by_officer IS 'Activity per system user, broken down by category. Useful for accountability reviews.';

-- (d) v_audit_authentication_log — login/logout/failed-login events
CREATE OR REPLACE VIEW v_audit_authentication_log AS
SELECT
    id,
    occurred_at,
    officer_name,
    officer_initials,
    activity,
    particulars,
    ip_address,
    user_agent,
    session_id,
    severity
FROM audit_log
WHERE category = 'authentication'::audit_category
  AND is_archived = FALSE
ORDER BY occurred_at DESC;

COMMENT ON VIEW v_audit_authentication_log IS 'Login/logout/failed-login events for security review.';

-- (e) v_audit_data_changes — row-level changes to business tables
CREATE OR REPLACE VIEW v_audit_data_changes AS
SELECT
    id,
    occurred_at,
    officer_name,
    officer_initials,
    table_name,
    operation,
    record_id,
    changed_fields,
    row_before,
    row_after,
    severity
FROM audit_log
WHERE table_name IS NOT NULL
  AND operation IS NOT NULL
  AND is_archived = FALSE
ORDER BY occurred_at DESC;

COMMENT ON VIEW v_audit_data_changes IS 'Row-level data changes (INSERT/UPDATE/DELETE) captured by the audit triggers, newest first.';

-- (f) v_audit_chain_integrity — last verification result
--     Materialized on demand: SELECT * FROM v_audit_chain_integrity;
--     To refresh, run: SELECT verify_audit_chain();
CREATE OR REPLACE VIEW v_audit_chain_integrity AS
SELECT
    id,
    occurred_at,
    officer_name,
    activity,
    prev_hash,
    row_hash,
    compute_audit_row_hash(audit_log) AS computed_hash,
    CASE
        WHEN row_hash = compute_audit_row_hash(audit_log) THEN 'OK'
        ELSE 'BROKEN'
    END AS status
FROM audit_log
WHERE is_archived = FALSE
ORDER BY id DESC
LIMIT 1000;

COMMENT ON VIEW v_audit_chain_integrity IS 'Most recent 1000 audit rows with their recomputed hash for chain verification.';

-- (g) v_audit_high_severity — critical & warning events needing attention
CREATE OR REPLACE VIEW v_audit_high_severity AS
SELECT
    id,
    occurred_at,
    officer_name,
    officer_initials,
    officer_role,
    activity,
    particulars,
    category,
    severity,
    table_name,
    operation,
    record_id
FROM audit_log
WHERE severity IN ('critical', 'warning')
  AND is_archived = FALSE
ORDER BY occurred_at DESC;

COMMENT ON VIEW v_audit_high_severity IS 'Critical and warning audit events requiring admin attention.';

-- (h) v_audit_retention_status — retention policy and aging
CREATE OR REPLACE VIEW v_audit_retention_status AS
SELECT
    p.category,
    p.retention_days,
    p.archive_after_days,
    p.auto_archive,
    p.notes,
    COUNT(*) FILTER (WHERE a.occurred_at < CURRENT_DATE - p.archive_after_days
                       AND a.is_archived = FALSE)        AS rows_eligible_for_archive,
    COUNT(*) FILTER (WHERE a.occurred_at < CURRENT_DATE - p.retention_days
                       AND a.is_archived = FALSE)        AS rows_past_retention,
    COUNT(*) FILTER (WHERE a.is_archived = TRUE)         AS rows_archived,
    COUNT(*)                                              AS total_rows
FROM audit_retention_policy p
LEFT JOIN audit_log a ON a.category = p.category
GROUP BY p.category, p.retention_days, p.archive_after_days, p.auto_archive, p.notes
ORDER BY p.category;

COMMENT ON VIEW v_audit_retention_status IS 'Per-category retention policy with row counts for eligible-to-archive, past-retention, and already-archived.';

-- ----------------------------------------------------------------------------
-- 13. Initial seed audit entries
--     Log the migration itself as the first audit event in the new format.
--     (This row will be the start of the hash chain.)
-- ----------------------------------------------------------------------------
INSERT INTO audit_log (
    occurred_at,
    officer_name, officer_initials, officer_role,
    activity, particulars,
    category, severity,
    table_name, operation
) VALUES (
    NOW(),
    'System Admin', 'SA', 'Admin',
    'Audit subsystem initialized',
    'Migration 004_audit.sql installed: hash-chained audit_log, table-level triggers on 23 tables, retention policies, verification function.',
    'system', 'notice',
    'audit_log', 'INSERT'
);

COMMIT;

-- ============================================================================
-- Verification queries (run after migration to confirm health):
--
--   -- 1. Verify the hash chain is intact
--   SELECT * FROM verify_audit_chain();
--
--   -- 2. Check that audit triggers exist on the core tables
--   SELECT tgname, tgrelid::regclass AS table_name
--     FROM pg_trigger
--    WHERE tgname LIKE 'trg_%_audit'
--      AND NOT tgisinternal
--    ORDER BY table_name;
--
--   -- 3. Test the generic logging function
--   SELECT log_audit_event('Test event', 'Verifying audit pipeline', 'system'::audit_category, 'info'::audit_severity);
--
--   -- 4. View high-severity events
--   SELECT * FROM v_audit_high_severity LIMIT 20;
--
--   -- 5. Retention status by category
--   SELECT * FROM v_audit_retention_status;
-- ============================================================================

-- End of 004_audit.sql
