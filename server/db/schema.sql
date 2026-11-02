-- Elite SACCO Mbarara PostgreSQL schema
-- This file creates the core PostgreSQL tables and supporting enums for:
-- - users and RBAC
-- - members
-- - savings transactions
-- - loan applications, disbursements and repayments
-- - audit trail
-- - regulatory reporting support

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- Enums
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE user_role AS ENUM (
      'Admin',
      'Treasurer',
      'Credit Supervisor',
      'Credit Officer',
      'Member'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'member_gender') THEN
    CREATE TYPE member_gender AS ENUM ('F', 'M', 'Other');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tx_direction') THEN
    CREATE TYPE tx_direction AS ENUM ('Deposit', 'Withdrawal');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'savings_channel') THEN
    CREATE TYPE savings_channel AS ENUM (
      'Counter / Cash',
      'Bank Transfer',
      'Mobile Money',
      'Cheque',
      'Other'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'loan_status') THEN
    CREATE TYPE loan_status AS ENUM ('Pending', 'Approved', 'Rejected', 'On Hold');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'loan_lifecycle_status') THEN
    CREATE TYPE loan_lifecycle_status AS ENUM (
      'Active',
      'Closed',
      'Written Off',
      'Restructured'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_type') THEN
    CREATE TYPE payment_type AS ENUM (
      'Installment',
      'Top up',
      'Interest',
      'Penalty',
      'Write-off',
      'Other'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'applicant_type') THEN
    CREATE TYPE applicant_type AS ENUM ('Member', 'Non-member');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'audit_operation') THEN
    CREATE TYPE audit_operation AS ENUM ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'audit_severity') THEN
    CREATE TYPE audit_severity AS ENUM ('info', 'notice', 'warning', 'critical');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'audit_category') THEN
    CREATE TYPE audit_category AS ENUM (
      'authentication',
      'user_management',
      'member_management',
      'loan_request',
      'loan_disbursement',
      'loan_repayment',
      'savings',
      'regulatory',
      'system'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'reporting_basis') THEN
    CREATE TYPE reporting_basis AS ENUM ('m', 'q', 'y');
  END IF;
END $$;

-- ============================================================
-- Users
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role user_role NOT NULL DEFAULT 'Member',
  initials TEXT,
  password_hash TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_role
  ON users (role);

CREATE INDEX IF NOT EXISTS idx_users_active
  ON users (is_active);

-- ============================================================
-- Members
-- ============================================================

CREATE TABLE IF NOT EXISTS members (
  id SERIAL PRIMARY KEY,
  account_number TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  gender member_gender NOT NULL,
  date_of_birth DATE,
  telephone TEXT NOT NULL,
  email TEXT,
  nin TEXT NOT NULL UNIQUE,
  address TEXT,
  photo TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_members_account_number
  ON members (account_number);

CREATE INDEX IF NOT EXISTS idx_members_name
  ON members (LOWER(first_name), LOWER(last_name));

CREATE INDEX IF NOT EXISTS idx_members_telephone
  ON members (telephone);

CREATE INDEX IF NOT EXISTS idx_members_nin
  ON members (nin);

-- ============================================================
-- Loan requests
-- ============================================================

CREATE TABLE IF NOT EXISTS loan_requests (
  id SERIAL PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  request_date DATE NOT NULL DEFAULT CURRENT_DATE,
  applicant_type applicant_type NOT NULL DEFAULT 'Member',
  account_number TEXT,
  applicant_name TEXT NOT NULL,
  telephone TEXT NOT NULL,
  email TEXT,
  address TEXT,
  category TEXT NOT NULL,
  term_months INTEGER NOT NULL CHECK (term_months BETWEEN 1 AND 60),
  principal NUMERIC(14,2) NOT NULL CHECK (principal > 0),
  rate_monthly NUMERIC(8,4) NOT NULL CHECK (rate_monthly >= 0),
  nin TEXT,
  status loan_status NOT NULL DEFAULT 'Pending',
  remark TEXT,
  requested_by INTEGER REFERENCES users(id),
  requested_by_initials TEXT,
  decided_by INTEGER REFERENCES users(id),
  decided_on DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loan_requests_status
  ON loan_requests (status);

CREATE INDEX IF NOT EXISTS idx_loan_requests_request_date
  ON loan_requests (request_date DESC);

CREATE INDEX IF NOT EXISTS idx_loan_requests_account_number
  ON loan_requests (account_number);

-- ============================================================
-- Loans
-- ============================================================

CREATE TABLE IF NOT EXISTS loans (
  id SERIAL PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  request_id INTEGER REFERENCES loan_requests(id),
  account_number TEXT,
  non_member_id INTEGER,
  borrower_name TEXT NOT NULL,
  telephone TEXT NOT NULL,
  category TEXT NOT NULL,
  term_months INTEGER NOT NULL CHECK (term_months BETWEEN 1 AND 60),
  principal NUMERIC(14,2) NOT NULL CHECK (principal > 0),
  rate_monthly NUMERIC(8,4) NOT NULL CHECK (rate_monthly >= 0),
  disbursed_on DATE NOT NULL,
  due_date DATE,
  status loan_lifecycle_status NOT NULL DEFAULT 'Active',
  monthly_installment NUMERIC(14,2),
  total_payable NUMERIC(14,2),
  officer_id INTEGER REFERENCES users(id),
  officer_initials TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loans_status
  ON loans (status);

CREATE INDEX IF NOT EXISTS idx_loans_account_number
  ON loans (account_number);

CREATE INDEX IF NOT EXISTS idx_loans_disbursed_on
  ON loans (disbursed_on DESC);

CREATE INDEX IF NOT EXISTS idx_loans_borrower_name
  ON loans (LOWER(borrower_name));

-- ============================================================
-- Loan repayments
-- ============================================================

CREATE TABLE IF NOT EXISTS loan_repayments (
  id SERIAL PRIMARY KEY,
  loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  payment_date DATE NOT NULL,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  payment_type payment_type NOT NULL DEFAULT 'Installment',
  officer_id INTEGER REFERENCES users(id),
  officer_initials TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loan_repayments_loan_id
  ON loan_repayments (loan_id);

CREATE INDEX IF NOT EXISTS idx_loan_repayments_payment_date
  ON loan_repayments (payment_date DESC);

-- ============================================================
-- Savings transactions
-- ============================================================

CREATE TABLE IF NOT EXISTS savings_transactions (
  id SERIAL PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  account_number TEXT NOT NULL,
  direction tx_direction NOT NULL,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  channel savings_channel NOT NULL DEFAULT 'Counter / Cash',
  slip_number TEXT,
  remarks TEXT,
  officer_id INTEGER REFERENCES users(id),
  officer_initials TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_savings_transactions_account_number
  ON savings_transactions (account_number);

CREATE INDEX IF NOT EXISTS idx_savings_transactions_occurred_at
  ON savings_transactions (occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_savings_transactions_direction
  ON savings_transactions (direction);

-- ============================================================
-- Regulatory templates
-- ============================================================

CREATE TABLE IF NOT EXISTS regulatory_return_templates (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_regulatory_return_templates_active
  ON regulatory_return_templates (is_active, sort_order);

-- ============================================================
-- Regulatory snapshots
-- ============================================================

CREATE TABLE IF NOT EXISTS regulatory_snapshots (
  id SERIAL PRIMARY KEY,
  year INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  template_id INTEGER NOT NULL REFERENCES regulatory_return_templates(id),
  basis reporting_basis NOT NULL DEFAULT 'm',
  n_months INTEGER NOT NULL DEFAULT 1 CHECK (n_months >= 1),
  snapshot_json JSONB NOT NULL DEFAULT '{}',
  generated_by INTEGER REFERENCES users(id),
  notes TEXT,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (year, month, template_id, basis)
);

CREATE INDEX IF NOT EXISTS idx_regulatory_snapshots_period
  ON regulatory_snapshots (year, month, template_id);

-- ============================================================
-- Audit log
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  officer_id INTEGER REFERENCES users(id),
  officer_name TEXT,
  officer_initials TEXT,
  officer_role user_role,
  activity TEXT NOT NULL,
  particulars TEXT,
  category audit_category NOT NULL DEFAULT 'system',
  severity audit_severity NOT NULL DEFAULT 'info',
  table_name TEXT,
  operation audit_operation,
  record_id TEXT,
  session_id TEXT,
  ip_address INET,
  user_agent TEXT,
  hash_prev TEXT,
  hash_current TEXT,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_audit_log_occurred_at
  ON audit_log (occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_category_severity
  ON audit_log (category, severity);

CREATE INDEX IF NOT EXISTS idx_audit_log_officer_id
  ON audit_log (officer_id);

CREATE INDEX IF NOT EXISTS idx_audit_log_table_name
  ON audit_log (table_name);

-- ============================================================
-- Audit helper functions
-- ============================================================

CREATE OR REPLACE FUNCTION log_audit_event(
  p_activity TEXT,
  p_particulars TEXT,
  p_category audit_category DEFAULT 'system',
  p_severity audit_severity DEFAULT 'info',
  p_user_id INTEGER DEFAULT NULL,
  p_table_name TEXT DEFAULT NULL,
  p_record_id TEXT DEFAULT NULL,
  p_session_id TEXT DEFAULT NULL,
  p_ip_address INET DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_officer_name TEXT;
  v_officer_initials TEXT;
  v_officer_role user_role;
  v_id BIGINT;
BEGIN
  SELECT name, initials, role
    INTO v_officer_name, v_officer_initials, v_officer_role
    FROM users
   WHERE id = p_user_id;

  INSERT INTO audit_log (
    officer_id,
    officer_name,
    officer_initials,
    officer_role,
    activity,
    particulars,
    category,
    severity,
    table_name,
    operation,
    record_id,
    session_id,
    ip_address,
    user_agent
  )
  VALUES (
    p_user_id,
    v_officer_name,
    v_officer_initials,
    v_officer_role,
    p_activity,
    p_particulars,
    p_category,
    p_severity,
    p_table_name,
    NULL,
    p_record_id,
    p_session_id,
    p_ip_address,
    p_user_agent
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Generic audit trigger for row-level changes.
-- This is intended to be attached to tables that should be tracked.
CREATE OR REPLACE FUNCTION audit_table_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_user_id INTEGER;
  v_session_id TEXT;
BEGIN
  v_user_id := NULLIF(current_setting('app.current_user_id', TRUE), '')::INTEGER;
  v_session_id := COALESCE(NULLIF(current_setting('app.session_id', TRUE), ''), NULL);

  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_log (
      officer_id,
      officer_name,
      officer_initials,
      officer_role,
      activity,
      particulars,
      category,
      severity,
      table_name,
      operation,
      record_id,
      session_id
    )
    SELECT
      v_user_id,
      u.name,
      u.initials,
      u.role,
      'INSERT',
      jsonb_build_object('new_row', to_jsonb(NEW))::TEXT,
      'system',
      'info',
      TG_TABLE_NAME,
      'INSERT',
      CAST(NEW.id AS TEXT),
      v_session_id
    FROM users u
    WHERE u.id = v_user_id;

    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO audit_log (
      officer_id,
      officer_name,
      officer_initials,
      officer_role,
      activity,
      particulars,
      category,
      severity,
      table_name,
      operation,
      record_id,
      session_id
    )
    SELECT
      v_user_id,
      u.name,
      u.initials,
      u.role,
      'UPDATE',
      jsonb_build_object(
        'old_row', to_jsonb(OLD),
        'new_row', to_jsonb(NEW)
      )::TEXT,
      'system',
      'info',
      TG_TABLE_NAME,
      'UPDATE',
      CAST(NEW.id AS TEXT),
      v_session_id
    FROM users u
    WHERE u.id = v_user_id;

    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO audit_log (
      officer_id,
      officer_name,
      officer_initials,
      officer_role,
      activity,
      particulars,
      category,
      severity,
      table_name,
      operation,
      record_id,
      session_id
    )
    SELECT
      v_user_id,
      u.name,
      u.initials,
      u.role,
      'DELETE',
      jsonb_build_object('deleted_row', to_jsonb(OLD))::TEXT,
      'system',
      'info',
      TG_TABLE_NAME,
      'DELETE',
      CAST(OLD.id AS TEXT),
      v_session_id
    FROM users u
    WHERE u.id = v_user_id;

    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$;

-- ============================================================
-- Helpful database checks
-- ============================================================

-- Optional: this is useful if you want to verify that the main tables are present.
-- Example:
-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
-- ORDER BY table_name;
