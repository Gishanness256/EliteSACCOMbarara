-- ============================================================================
-- Migration: 001_init.sql
-- Project:   Elite SACCO Mbarara — Core schema
-- Database:  PostgreSQL (>= 12)
-- Purpose:   Initial schema for the SACCO core tables: users, roles,
--            permissions, members, non-members, savings, loans, repayments,
--            loan requests, audit log and regulatory config.
-- Generated: 2026-10-22
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. Enums / domains
-- ----------------------------------------------------------------------------
-- Reusable enumerated types keep the schema self-documenting and prevent
-- invalid values from being written by application code.

DO $$ BEGIN
    CREATE TYPE member_gender AS ENUM ('F', 'M');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE user_role AS ENUM (
        'Admin',
        'Treasurer',
        'Credit Supervisor',
        'Credit Officer'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE loan_status AS ENUM ('Pending', 'On Hold', 'Approved', 'Rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE loan_lifecycle_status AS ENUM ('Active', 'Overdue', 'Cleared');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE applicant_type AS ENUM ('m', 'n'); -- member / non-member
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE tx_direction AS ENUM ('Deposit', 'Withdrawal');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE savings_channel AS ENUM (
        'Counter / Cash',
        'Mobile money',
        'Bank transfer',
        'Salary deduction',
        'Agent',
        'Imported'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE payment_type AS ENUM ('Installment', 'Lump sum', 'Full settlement', 'Imported');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE reporting_basis AS ENUM ('m', 'mom', 'yoy');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- 1. users — system users (staff who operate the system)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id              BIGSERIAL PRIMARY KEY,
    name            TEXT           NOT NULL,
    email           TEXT           NOT NULL UNIQUE,
    password_hash   TEXT,          -- stored hashed; never plaintext in prod
    role            user_role      NOT NULL DEFAULT 'Credit Officer',
    initials        TEXT           CHECK (char_length(initials) BETWEEN 1 AND 4),
    is_active       BOOLEAN        NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    last_login_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_role      ON users (role);
CREATE INDEX IF NOT EXISTS idx_users_active    ON users (is_active);
CREATE INDEX IF NOT EXISTS idx_users_lower_email ON users (LOWER(email));

COMMENT ON TABLE  users IS 'System users: Admin, Treasurer, Credit Supervisor, Credit Officer.';
COMMENT ON COLUMN users.email IS 'Login handle is <name>@elitesacco.co.ug.';

-- ----------------------------------------------------------------------------
-- 2. permissions & roles — RBAC matrix
--    Mirrors the JS PERMS array and the default per-role grants.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS permissions (
    id    SMALLSERIAL PRIMARY KEY,
    code  TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
    role            user_role   NOT NULL,
    permission_id   SMALLINT    NOT NULL REFERENCES permissions (id) ON DELETE CASCADE,
    PRIMARY KEY (role, permission_id)
);

-- Seed permissions (order matches the front-end PERMS array)
INSERT INTO permissions (code, label) VALUES
    ('approve_loans',         'Approve loans'),
    ('ack_savings',           'Acknowledge savings/deposits'),
    ('ack_loan_repayments',   'Acknowledge loan repayments'),
    ('set_interest_rates',    'Set interest rates'),
    ('manage_users',          'Create/remove system users'),
    ('manage_members',        'Create/remove member accounts'),
    ('weekly_reports',        'Weekly reports'),
    ('monthly_reports',       'Monthly reports'),
    ('annual_reports',        'Annual reports')
ON CONFLICT (code) DO NOTHING;

-- Default grants (matches dflt() in the front-end)
INSERT INTO role_permissions (role, permission_id)
    SELECT 'Admin', id FROM permissions
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role, permission_id)
    SELECT 'Treasurer', id FROM permissions
    WHERE code IN ('ack_savings','ack_loan_repayments','weekly_reports','monthly_reports','annual_reports')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role, permission_id)
    SELECT 'Credit Supervisor', id FROM permissions
    WHERE code IN ('approve_loans','ack_loan_repayments','set_interest_rates','weekly_reports','monthly_reports')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role, permission_id)
    SELECT 'Credit Officer', id FROM permissions
    WHERE code IN ('ack_savings','ack_loan_repayments')
ON CONFLICT DO NOTHING;

-- ----------------------------------------------------------------------------
-- 3. loan_categories — pricing reference table
--    Mirrors the JS CATS map (base rate % per month).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loan_categories (
    id          SMALLSERIAL PRIMARY KEY,
    name        TEXT        NOT NULL UNIQUE,
    base_rate   NUMERIC(5,2) NOT NULL CHECK (base_rate > 0), -- % per month
    is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO loan_categories (name, base_rate) VALUES
    ('Normal Loan',          3.00),
    ('Special Loan',         2.50),
    ('Secured Business Loan',2.50),
    ('Agricultural Loan',    2.00),
    ('School Fees Loan',     2.00)
ON CONFLICT (name) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 4. members — SACCO account holders
--    Account number format: "ES-{F|M} {000000}", e.g. "ES-F 000001".
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS members (
    id              BIGSERIAL    PRIMARY KEY,
    account_number  TEXT         NOT NULL UNIQUE,         -- "ES-F 000001"
    first_name      TEXT         NOT NULL,
    last_name       TEXT         NOT NULL,
    gender          member_gender NOT NULL,
    date_of_birth   DATE,
    address         TEXT,
    nin             TEXT,                                 -- National ID No.
    telephone       TEXT,
    email           TEXT,
    photo           TEXT,                                 -- base64 data URL
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by      BIGINT       REFERENCES users (id) ON DELETE SET NULL,

    CONSTRAINT chk_member_account_format
        CHECK (account_number ~ '^ES-[FM] [0-9]{6}$')
);

CREATE INDEX IF NOT EXISTS idx_members_lower_name ON members (LOWER(first_name || ' ' || last_name));
CREATE INDEX IF NOT EXISTS idx_members_telephone  ON members (telephone);
CREATE INDEX IF NOT EXISTS idx_members_nin        ON members (nin);
CREATE INDEX IF NOT EXISTS idx_members_active     ON members (is_active);

COMMENT ON COLUMN members.account_number IS 'Format: ES-{F|M} {6-digit zero-padded sequence}.';
COMMENT ON COLUMN members.photo IS 'Base64 data URL of passport photo.';

-- ----------------------------------------------------------------------------
-- 5. non_members — borrowers without a SACCO account
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS non_members (
    id           BIGSERIAL   PRIMARY KEY,
    external_id  TEXT        NOT NULL UNIQUE,             -- surrogate id used by app
    name         TEXT        NOT NULL,
    telephone    TEXT,
    nin          TEXT,
    is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by   BIGINT      REFERENCES users (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_non_members_lower_name ON non_members (LOWER(name));
CREATE INDEX IF NOT EXISTS idx_non_members_telephone  ON non_members (telephone);

-- ----------------------------------------------------------------------------
-- 6. savings_transactions — member deposits and withdrawals
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS savings_transactions (
    id              BIGSERIAL      PRIMARY KEY,
    reference       TEXT           NOT NULL UNIQUE,        -- "SV-000001"
    account_number  TEXT           NOT NULL REFERENCES members (account_number) ON DELETE RESTRICT,
    direction       tx_direction   NOT NULL,
    amount          NUMERIC(18,2)  NOT NULL CHECK (amount > 0),
    occurred_at     TIMESTAMPTZ    NOT NULL,
    channel         savings_channel NOT NULL DEFAULT 'Counter / Cash',
    slip_number     TEXT,
    remarks         TEXT,
    officer_id      BIGINT         REFERENCES users (id) ON DELETE SET NULL,
    officer_initials TEXT,
    created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_savings_account   ON savings_transactions (account_number);
CREATE INDEX IF NOT EXISTS idx_savings_date      ON savings_transactions (occurred_at);
CREATE INDEX IF NOT EXISTS idx_savings_direction ON savings_transactions (direction);
CREATE INDEX IF NOT EXISTS idx_savings_slip      ON savings_transactions (slip_number);

COMMENT ON TABLE savings_transactions IS 'Member deposits and withdrawals. amount is always positive; direction distinguishes them.';

-- ----------------------------------------------------------------------------
-- 7. loan_requests — applications awaiting approval
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loan_requests (
    id              BIGSERIAL       PRIMARY KEY,
    reference       TEXT            NOT NULL UNIQUE,       -- "LR-0001"
    request_date    DATE            NOT NULL DEFAULT CURRENT_DATE,
    applicant_type  applicant_type  NOT NULL,              -- 'm' or 'n'
    account_number  TEXT            REFERENCES members (account_number) ON DELETE SET NULL,
    non_member_id   TEXT            REFERENCES non_members (external_id) ON DELETE SET NULL,
    applicant_name  TEXT            NOT NULL,
    telephone       TEXT,
    email           TEXT,
    address         TEXT,
    category        TEXT            NOT NULL,
    term_months     INTEGER         NOT NULL CHECK (term_months BETWEEN 1 AND 60),
    principal       NUMERIC(18,2)   NOT NULL CHECK (principal > 0),
    rate_monthly    NUMERIC(5,2)    NOT NULL CHECK (rate_monthly BETWEEN 0.01 AND 30), -- %/month
    status          loan_status     NOT NULL DEFAULT 'Pending',
    remark          TEXT,
    requested_by    BIGINT          REFERENCES users (id) ON DELETE SET NULL,
    requested_by_initials TEXT,
    decided_by      BIGINT          REFERENCES users (id) ON DELETE SET NULL,
    decided_on      DATE,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_request_applicant
        CHECK (
            (applicant_type = 'm' AND account_number IS NOT NULL)
            OR
            (applicant_type = 'n' AND non_member_id IS NOT NULL)
        )
);

CREATE INDEX IF NOT EXISTS idx_loan_requests_status   ON loan_requests (status);
CREATE INDEX IF NOT EXISTS idx_loan_requests_account  ON loan_requests (account_number);
CREATE INDEX IF NOT EXISTS idx_loan_requests_date     ON loan_requests (request_date);

-- ----------------------------------------------------------------------------
-- 8. loans — approved / disbursed loans
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loans (
    id              BIGSERIAL       PRIMARY KEY,
    reference       TEXT            NOT NULL UNIQUE,        -- "LN-0001"
    request_id      BIGINT          REFERENCES loan_requests (id) ON DELETE SET NULL,
    account_number  TEXT            REFERENCES members (account_number) ON DELETE SET NULL,
    non_member_id   TEXT            REFERENCES non_members (external_id) ON DELETE SET NULL,
    borrower_name   TEXT            NOT NULL,
    telephone       TEXT,
    category        TEXT            NOT NULL,
    term_months     INTEGER         CHECK (term_months IS NULL OR term_months BETWEEN 1 AND 60),
    principal       NUMERIC(18,2)   NOT NULL CHECK (principal > 0),
    rate_monthly    NUMERIC(5,2)    NOT NULL CHECK (rate_monthly BETWEEN 0.01 AND 30),
    disbursed_on    DATE            NOT NULL,
    due_date        DATE,                                    -- disbursed_on + term_months
    status          loan_lifecycle_status NOT NULL DEFAULT 'Active',
    officer_id      BIGINT          REFERENCES users (id) ON DELETE SET NULL,
    officer_initials TEXT,
    imported        BOOLEAN         NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_loan_borrower
        CHECK (account_number IS NOT NULL OR non_member_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_loans_account   ON loans (account_number);
CREATE INDEX IF NOT EXISTS idx_loans_status    ON loans (status);
CREATE INDEX IF NOT EXISTS idx_loans_due_date  ON loans (due_date);
CREATE INDEX IF NOT EXISTS idx_loans_category  ON loans (category);
CREATE INDEX IF NOT EXISTS idx_loans_disbursed ON loans (disbursed_on);

COMMENT ON COLUMN loans.rate_monthly IS 'Monthly interest rate (% per month), compounded monthly on outstanding balance.';
COMMENT ON COLUMN loans.due_date IS 'Disbursed-on date plus term_months. NULL when term is unknown (excluded from PAR ageing).';

-- ----------------------------------------------------------------------------
-- 9. loan_repayments — repayments applied to a loan
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loan_repayments (
    id              BIGSERIAL      PRIMARY KEY,
    loan_id         BIGINT         NOT NULL REFERENCES loans (id) ON DELETE CASCADE,
    payment_date    DATE           NOT NULL,
    amount          NUMERIC(18,2)  NOT NULL CHECK (amount > 0),
    payment_type    payment_type   NOT NULL DEFAULT 'Installment',
    officer_id      BIGINT         REFERENCES users (id) ON DELETE SET NULL,
    officer_initials TEXT,
    created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repayments_loan ON loan_repayments (loan_id);
CREATE INDEX IF NOT EXISTS idx_repayments_date ON loan_repayments (payment_date);

-- ----------------------------------------------------------------------------
-- 10. audit_log — append-only activity log (System Auditor)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
    id              BIGSERIAL   PRIMARY KEY,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    officer_id      BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    officer_name    TEXT        NOT NULL,
    officer_initials TEXT,
    officer_role    TEXT,
    activity        TEXT        NOT NULL,
    particulars     TEXT,
    ip_address      INET,
    user_agent      TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_occurred ON audit_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_officer  ON audit_log (officer_id);
CREATE INDEX IF NOT EXISTS idx_audit_activity ON audit_log (activity);

COMMENT ON TABLE audit_log IS 'Immutable record of actions performed by system users. Never updated or deleted from the application.';

-- ----------------------------------------------------------------------------
-- 11. regulatory_config — institution details, benchmarks & provision rates
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS regulatory_config (
    id                     SMALLSERIAL PRIMARY KEY,
    regulator              TEXT        NOT NULL DEFAULT 'Uganda Microfinance Regulatory Authority (UMRA)',
    licence_number         TEXT,
    min_liquidity_ratio    NUMERIC(5,2) NOT NULL DEFAULT 15.00,   -- %
    min_core_capital_pct   NUMERIC(5,2) NOT NULL DEFAULT 10.00,   -- % of total assets
    min_institutional_pct  NUMERIC(5,2) NOT NULL DEFAULT 8.00,    -- % of total assets
    max_par_30             NUMERIC(5,2) NOT NULL DEFAULT 5.00,    -- %
    max_par_90             NUMERIC(5,2) NOT NULL DEFAULT 2.00,    -- %
    -- Provision rates per ageing bucket:
    prov_current           NUMERIC(5,2) NOT NULL DEFAULT 1.00,    -- %  (not yet due)
    prov_1_29              NUMERIC(5,2) NOT NULL DEFAULT 5.00,    -- %
    prov_30_59             NUMERIC(5,2) NOT NULL DEFAULT 25.00,   -- %
    prov_60_89             NUMERIC(5,2) NOT NULL DEFAULT 50.00,   -- %
    prov_90_plus           NUMERIC(5,2) NOT NULL DEFAULT 100.00,  -- %
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by             BIGINT      REFERENCES users (id) ON DELETE SET NULL
);

INSERT INTO regulatory_config (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 12. regulatory_inputs — monthly manual financial inputs
--     (cash, bank, capital, income & expenses) for regulatory returns.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS regulatory_inputs (
    id                       BIGSERIAL    PRIMARY KEY,
    period_month             DATE         NOT NULL,   -- first day of the month
    cash_on_hand             NUMERIC(18,2) NOT NULL DEFAULT 0,
    bank_balances            NUMERIC(18,2) NOT NULL DEFAULT 0,
    other_liquid_investments NUMERIC(18,2) NOT NULL DEFAULT 0,
    other_assets             NUMERIC(18,2) NOT NULL DEFAULT 0,
    other_liabilities        NUMERIC(18,2) NOT NULL DEFAULT 0,
    member_share_capital     NUMERIC(18,2) NOT NULL DEFAULT 0,
    statutory_reserves       NUMERIC(18,2) NOT NULL DEFAULT 0,
    fee_income               NUMERIC(18,2) NOT NULL DEFAULT 0,
    savings_interest_paid    NUMERIC(18,2) NOT NULL DEFAULT 0,
    operating_expenses       NUMERIC(18,2) NOT NULL DEFAULT 0,
    notes                    TEXT,
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_by               BIGINT       REFERENCES users (id) ON DELETE SET NULL,

    UNIQUE (period_month)
);

CREATE INDEX IF NOT EXISTS idx_reg_inputs_month ON regulatory_inputs (period_month);

COMMENT ON TABLE regulatory_inputs IS 'Balance-sheet items carry forward to later months until changed; income/expense items apply to that month only.';

-- ----------------------------------------------------------------------------
-- 13. updated_at triggers — keep updated_at columns fresh
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
    CREATE TRIGGER trg_users_updated_at        BEFORE UPDATE ON users        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TRIGGER trg_members_updated_at      BEFORE UPDATE ON members      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TRIGGER trg_non_members_updated_at  BEFORE UPDATE ON non_members  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TRIGGER trg_loan_requests_updated_at BEFORE UPDATE ON loan_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TRIGGER trg_loans_updated_at        BEFORE UPDATE ON loans        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TRIGGER trg_reg_inputs_updated_at   BEFORE UPDATE ON regulatory_inputs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    CREATE TRIGGER trg_reg_config_updated_at   BEFORE UPDATE ON regulatory_config FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- 14. due_date auto-calculation trigger on loans
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_loan_due_date()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.term_months IS NOT NULL AND NEW.disbursed_on IS NOT NULL THEN
        NEW.due_date = (NEW.disbursed_on + (NEW.term_months || ' months')::INTERVAL)::DATE;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
    CREATE TRIGGER trg_loans_due_date
        BEFORE INSERT OR UPDATE OF disbursed_on, term_months ON loans
        FOR EACH ROW EXECUTE FUNCTION set_loan_due_date();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- 15. Seed: default Admin user (password must be reset on first login)
-- ----------------------------------------------------------------------------
INSERT INTO users (name, email, role, initials, password_hash)
VALUES ('System Admin', 'admin@elitesacco.co.ug', 'Admin', 'SA', NULL)
ON CONFLICT (email) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 16. Views — convenience for reporting
-- ----------------------------------------------------------------------------

-- Active loans with current outstanding balance (principal + accrued interest)
CREATE OR REPLACE VIEW v_active_loans AS
SELECT
    l.id,
    l.reference,
    COALESCE(l.account_number, '')                       AS account_number,
    l.borrower_name,
    l.category,
    l.term_months,
    l.principal,
    l.rate_monthly,
    l.disbursed_on,
    l.due_date,
    COALESCE((SELECT COALESCE(SUM(amount),0)
              FROM loan_repayments r WHERE r.loan_id = l.id), 0) AS amount_paid,
    l.status
FROM loans l
WHERE l.status <> 'Cleared';

-- Audit log summary by activity
CREATE OR REPLACE VIEW v_audit_summary AS
SELECT
    activity,
    officer_name,
    officer_role,
    COUNT(*)                AS event_count,
    MIN(occurred_at)        AS first_seen,
    MAX(occurred_at)        AS last_seen
FROM audit_log
GROUP BY activity, officer_name, officer_role;

COMMIT;

-- ============================================================================
-- End of 001_init.sql
-- ============================================================================
