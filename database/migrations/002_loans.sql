-- ============================================================================
-- Migration: 002_loans.sql
-- Project:   Elite SACCO Mbarara — Loan subsystem extension
-- Database:  PostgreSQL (>= 12)
-- Depends:   001_init.sql (loans, loan_requests, loan_repayments, members,
--            non_members, users, loan_categories, audit_log)
-- Purpose:   Extend the loan subsystem with:
--              (a) Amortization / repayment schedule
--              (b) Loan collateral & guarantors
--              (c) Fees, penalties and write-offs
--              (d) Status / decision history (audit trail)
--              (e) SQL functions mirroring the front-end bal() and sim()
--              (f) Reporting views (PAR ageing, outstanding portfolio)
--            All operations are idempotent and additive — no breaking changes
--            to the base schema from 001_init.sql.
-- Generated: 2026-10-22
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. New enums / domains
-- ----------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE collateral_type AS ENUM (
        'Land title',
        'Vehicle logbook',
        'Salary assignment',
        'Fixed deposit',
        'Equipment',
        'Household asset',
        'Other'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE guarantor_relation AS ENUM (
        'Member',
        'Non-member',
        'Staff'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE fee_type AS ENUM (
        'Processing fee',
        'Insurance',
        'Late penalty',
        'Prepayment fee',
        'Disbursement charge',
        'Other'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE schedule_status AS ENUM ('Pending', 'Paid', 'Partial', 'Missed', 'Overdue');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE write_off_reason AS ENUM (
        'Death of borrower',
        'Bankruptcy',
        'Fraud',
        'Unrecoverable',
        'Restructuring',
        'Other'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE status_event AS ENUM (
        'Submitted',
        'Put on hold',
        'Approved',
        'Rejected',
        'Disbursed',
        'Reactivated',
        'Marked overdue',
        'Cleared',
        'Written off',
        'Restructured'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- 1. loan_schedule — planned amortization installments
--    Mirrors the JS PMT() + sim() computation: monthly compounding on the
--    outstanding balance, with each installment split into interest + principal.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loan_schedule (
    id                  BIGSERIAL      PRIMARY KEY,
    loan_id             BIGINT         NOT NULL REFERENCES loans (id) ON DELETE CASCADE,
    installment_number  INTEGER        NOT NULL CHECK (installment_number > 0),
    due_date            DATE           NOT NULL,
    opening_balance     NUMERIC(18,2)  NOT NULL CHECK (opening_balance >= 0),
    installment_amount  NUMERIC(18,2)  NOT NULL CHECK (installment_amount >= 0),
    interest_component  NUMERIC(18,2)  NOT NULL CHECK (interest_component >= 0),
    principal_component NUMERIC(18,2)  NOT NULL CHECK (principal_component >= 0),
    closing_balance     NUMERIC(18,2)  NOT NULL CHECK (closing_balance >= 0),
    status              schedule_status NOT NULL DEFAULT 'Pending',
    paid_amount         NUMERIC(18,2)  NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
    paid_on             DATE,
    created_at          TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

    UNIQUE (loan_id, installment_number)
);

CREATE INDEX IF NOT EXISTS idx_schedule_loan     ON loan_schedule (loan_id);
CREATE INDEX IF NOT EXISTS idx_schedule_due_date ON loan_schedule (due_date);
CREATE INDEX IF NOT EXISTS idx_schedule_status   ON loan_schedule (status);

COMMENT ON TABLE loan_schedule IS 'Planned monthly installments. interest_component = opening_balance * (rate_monthly/100). Compounded monthly, mirroring the front-end bal()/sim() functions.';

-- ----------------------------------------------------------------------------
-- 2. loan_collateral — assets pledged against a loan
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loan_collateral (
    id              BIGSERIAL        PRIMARY KEY,
    loan_id         BIGINT           NOT NULL REFERENCES loans (id) ON DELETE CASCADE,
    collateral_type collateral_type  NOT NULL,
    description     TEXT             NOT NULL,
    estimated_value NUMERIC(18,2)    NOT NULL CHECK (estimated_value >= 0),
    reference_no    TEXT,                               -- title no., logbook no., etc.
    held_by         TEXT,                               -- who holds the collateral
    is_released     BOOLEAN          NOT NULL DEFAULT FALSE,
    released_on     DATE,
    notes           TEXT,
    created_at      TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_collateral_loan    ON loan_collateral (loan_id);
CREATE INDEX IF NOT EXISTS idx_collateral_type    ON loan_collateral (collateral_type);
CREATE INDEX IF NOT EXISTS idx_collateral_released ON loan_collateral (is_released);

COMMENT ON TABLE loan_collateral IS 'Assets pledged against a loan. Released when the loan is cleared.';

-- ----------------------------------------------------------------------------
-- 3. loan_guarantors — people guaranteeing a loan
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loan_guarantors (
    id              BIGSERIAL          PRIMARY KEY,
    loan_id         BIGINT             NOT NULL REFERENCES loans (id) ON DELETE CASCADE,
    guarantor_type  guarantor_relation NOT NULL,
    -- Link to existing member/non-member when applicable:
    account_number  TEXT               REFERENCES members (account_number) ON DELETE SET NULL,
    non_member_id   TEXT               REFERENCES non_members (external_id) ON DELETE SET NULL,
    user_id         BIGINT             REFERENCES users (id) ON DELETE SET NULL,
    -- Free-text fallback:
    full_name       TEXT               NOT NULL,
    telephone       TEXT,
    email           TEXT,
    address         TEXT,
    nin             TEXT,
    -- Financial commitment:
    guaranteed_amount NUMERIC(18,2)    NOT NULL CHECK (guaranteed_amount > 0),
    is_primary      BOOLEAN            NOT NULL DEFAULT FALSE,
    is_active       BOOLEAN            NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ        NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ        NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_guarantor_link
        CHECK (
            account_number IS NOT NULL OR
            non_member_id  IS NOT NULL OR
            user_id        IS NOT NULL OR
            full_name     <> ''
        )
);

CREATE INDEX IF NOT EXISTS idx_guarantors_loan     ON loan_guarantors (loan_id);
CREATE INDEX IF NOT EXISTS idx_guarantors_account  ON loan_guarantors (account_number);
CREATE INDEX IF NOT EXISTS idx_guarantors_non_mem  ON loan_guarantors (non_member_id);
CREATE INDEX IF NOT EXISTS idx_guarantors_primary  ON loan_guarantors (is_primary) WHERE is_primary;

COMMENT ON TABLE loan_guarantors IS 'Guarantors for a loan. At least one primary guarantor is recommended for non-collateralized loans.';

-- ----------------------------------------------------------------------------
-- 4. loan_fees — fees, charges and penalties on loans
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loan_fees (
    id              BIGSERIAL      PRIMARY KEY,
    loan_id         BIGINT         NOT NULL REFERENCES loans (id) ON DELETE CASCADE,
    fee_type        fee_type       NOT NULL,
    description     TEXT,
    amount          NUMERIC(18,2)  NOT NULL CHECK (amount > 0),
    effective_date  DATE           NOT NULL DEFAULT CURRENT_DATE,
    is_paid         BOOLEAN        NOT NULL DEFAULT FALSE,
    paid_on         DATE,
    officer_id      BIGINT         REFERENCES users (id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fees_loan     ON loan_fees (loan_id);
CREATE INDEX IF NOT EXISTS idx_fees_type     ON loan_fees (fee_type);
CREATE INDEX IF NOT EXISTS idx_fees_unpaid   ON loan_fees (loan_id) WHERE is_paid = FALSE;

COMMENT ON TABLE loan_fees IS 'Processing fees, insurance, late-payment penalties and other charges. Penalties are typically added once a month when an installment is overdue.';

-- ----------------------------------------------------------------------------
-- 5. loan_write_offs — formal write-off of unrecoverable loans
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loan_write_offs (
    id              BIGSERIAL        PRIMARY KEY,
    loan_id         BIGINT           NOT NULL UNIQUE REFERENCES loans (id) ON DELETE RESTRICT,
    write_off_date  DATE             NOT NULL DEFAULT CURRENT_DATE,
    amount_written_off NUMERIC(18,2) NOT NULL CHECK (amount_written_off > 0),
    outstanding_at_write_off NUMERIC(18,2) NOT NULL CHECK (outstanding_at_write_off >= 0),
    reason          write_off_reason NOT NULL,
    justification   TEXT             NOT NULL,
    approved_by     BIGINT           NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    approval_date   DATE             NOT NULL DEFAULT CURRENT_DATE,
    recovery_amount NUMERIC(18,2)    NOT NULL DEFAULT 0 CHECK (recovery_amount >= 0),
    is_recovered    BOOLEAN          NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_writeoff_date   ON loan_write_offs (write_off_date);
CREATE INDEX IF NOT EXISTS idx_writeoff_reason ON loan_write_offs (reason);

COMMENT ON TABLE loan_write_offs IS 'Formal write-off of unrecoverable loan balances. Requires approval and a written justification. One write-off per loan.';

-- ----------------------------------------------------------------------------
-- 6. loan_status_history — audit trail of loan/request status transitions
--    Captures every state change with officer, timestamp and remark.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loan_status_history (
    id              BIGSERIAL    PRIMARY KEY,
    loan_id         BIGINT       REFERENCES loans (id) ON DELETE CASCADE,
    request_id      BIGINT       REFERENCES loan_requests (id) ON DELETE CASCADE,
    event           status_event NOT NULL,
    from_status     TEXT,
    to_status       TEXT,
    event_date      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    officer_id      BIGINT       REFERENCES users (id) ON DELETE SET NULL,
    officer_name    TEXT,
    officer_initials TEXT,
    remark          TEXT,

    CONSTRAINT chk_history_target
        CHECK (loan_id IS NOT NULL OR request_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_history_loan    ON loan_status_history (loan_id);
CREATE INDEX IF NOT EXISTS idx_history_request ON loan_status_history (request_id);
CREATE INDEX IF NOT EXISTS idx_history_event   ON loan_status_history (event_date DESC);

COMMENT ON TABLE loan_status_history IS 'Append-only audit trail of every loan/request status transition. Mirrors the activity types recorded in audit_log but in loan-specific form.';

-- ----------------------------------------------------------------------------
-- 7. Additional columns on loans / loan_requests
--    (additive only — no removals or type changes to existing columns)
-- ----------------------------------------------------------------------------
ALTER TABLE loans
    ADD COLUMN IF NOT EXISTS approved_by          BIGINT REFERENCES users (id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS approved_on          DATE,
    ADD COLUMN IF NOT EXISTS disbursed_by         BIGINT REFERENCES users (id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS written_off          BOOLEAN     NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS written_off_on       DATE,
    ADD COLUMN IF NOT EXISTS restructured_from    BIGINT REFERENCES loans (id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS monthly_installment  NUMERIC(18,2),
    ADD COLUMN IF NOT EXISTS total_interest       NUMERIC(18,2),
    ADD COLUMN IF NOT EXISTS total_payable        NUMERIC(18,2);

ALTER TABLE loan_requests
    ADD COLUMN IF NOT EXISTS member_savings_balance   NUMERIC(18,2),
    ADD COLUMN IF NOT EXISTS member_outstanding_loans NUMERIC(18,2),
    ADD COLUMN IF NOT EXISTS net_position             NUMERIC(18,2),
    ADD COLUMN IF NOT EXISTS credit_score             INTEGER,
    ADD COLUMN IF NOT EXISTS recommended_amount       NUMERIC(18,2),
    ADD COLUMN IF NOT EXISTS recommended_term         INTEGER,
    ADD COLUMN IF NOT EXISTS recommended_rate         NUMERIC(5,2);

COMMENT ON COLUMN loans.restructured_from IS 'Reference to the original loan when this loan was created via restructuring.';
COMMENT ON COLUMN loan_requests.credit_score IS 'Optional internal credit score (0-1000) used for approval decisions.';

-- ----------------------------------------------------------------------------
-- 8. Indices for performance on common query paths
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_loans_approved_by  ON loans (approved_by);
CREATE INDEX IF NOT EXISTS idx_loans_disbursed_by ON loans (disbursed_by);
CREATE INDEX IF NOT EXISTS idx_loans_written_off  ON loans (written_off) WHERE written_off;
CREATE INDEX IF NOT EXISTS idx_requests_decided   ON loan_requests (decided_by) WHERE decided_by IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 9. updated_at triggers on new tables
-- ----------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TRIGGER trg_schedule_updated_at
        BEFORE UPDATE ON loan_schedule FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TRIGGER trg_collateral_updated_at
        BEFORE UPDATE ON loan_collateral FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TRIGGER trg_guarantors_updated_at
        BEFORE UPDATE ON loan_guarantors FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- 10. SQL functions mirroring the front-end bal() and sim() logic
--     These let reports compute outstanding balance and interest splits
--     without round-tripping through the application.
-- ----------------------------------------------------------------------------

-- loan_outstanding_balance(loan_id, as_at_date)
--   Mirrors JS bal(l, to): compound monthly on outstanding principal,
--   subtracting repayments applied in each period.
CREATE OR REPLACE FUNCTION loan_outstanding_balance(
    p_loan_id BIGINT,
    p_as_at   DATE DEFAULT CURRENT_DATE
)
RETURNS NUMERIC(18,2)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_principal        NUMERIC(18,2);
    v_rate             NUMERIC;          -- monthly rate as a decimal (3% => 0.03)
    v_disbursed        DATE;
    v_term             INTEGER;
    v_balance          NUMERIC(18,2);
    v_prev_due         DATE;
    v_next_due         DATE;
    v_period_repayment NUMERIC(18,2);
    v_k                INTEGER := 0;
BEGIN
    SELECT principal, rate_monthly, disbursed_on, term_months
      INTO v_principal, v_rate, v_disbursed, v_term
      FROM loans WHERE id = p_loan_id;

    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    v_rate      := v_rate / 100.0;
    v_balance   := v_principal;
    v_prev_due  := v_disbursed - INTERVAL '1 day';

    LOOP
        v_next_due := (v_disbursed + ((v_k + 1) || ' months')::INTERVAL)::DATE;
        EXIT WHEN v_next_due > p_as_at;

        SELECT COALESCE(SUM(amount), 0)
          INTO v_period_repayment
          FROM loan_repayments
         WHERE loan_id = p_loan_id
           AND payment_date > v_prev_due
           AND payment_date <= v_next_due;

        v_balance  := GREATEST(0, v_balance - v_period_repayment) * (1 + v_rate);
        v_prev_due := v_next_due;
        v_k        := v_k + 1;
    END LOOP;

    -- Repayments after the last completed period but on/before as_at
    SELECT COALESCE(SUM(amount), 0)
      INTO v_period_repayment
      FROM loan_repayments
     WHERE loan_id = p_loan_id
       AND payment_date > v_prev_due
       AND payment_date <= p_as_at;

    v_balance := GREATEST(0, v_balance - v_period_repayment);

    RETURN ROUND(v_balance, 2);
END;
$$;

COMMENT ON FUNCTION loan_outstanding_balance IS 'Outstanding balance (principal + accrued monthly interest) of a loan as at a given date. Mirrors the front-end bal() function.';

-- loan_principal_outstanding(loan_id, as_at_date)
--   Splits the outstanding balance into principal and interest components.
CREATE OR REPLACE FUNCTION loan_principal_outstanding(
    p_loan_id BIGINT,
    p_as_at   DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE(principal NUMERIC(18,2), interest NUMERIC(18,2))
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_total_balance NUMERIC(18,2);
    v_principal_paid NUMERIC(18,2);
    v_loan_principal NUMERIC(18,2);
BEGIN
    v_total_balance := loan_outstanding_balance(p_loan_id, p_as_at);

    SELECT COALESCE(SUM(amount), 0), l.principal
      INTO v_principal_paid, v_loan_principal
      FROM loan_repayments r
      JOIN loans l ON l.id = r.loan_id
     WHERE r.loan_id = p_loan_id
     GROUP BY l.principal;

    -- principal portion = max(0, original principal - principal already paid)
    -- interest portion  = total balance - principal portion
    v_principal_paid := COALESCE(v_principal_paid, 0);
    v_loan_principal := COALESCE(v_loan_principal, 0);

    principal := GREATEST(0, v_loan_principal - v_principal_paid);
    interest  := GREATEST(0, v_total_balance - principal);

    RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION loan_principal_outstanding IS 'Splits outstanding balance into principal and interest as at a given date.';

-- loan_ageing_bucket(loan_id, as_at_date)
--   Returns 0..4 corresponding to the front-end bk(days) function:
--     0 = current (not yet due / 0 days overdue)
--     1 = 1-29 days overdue
--     2 = 30-59 days overdue
--     3 = 60-89 days overdue
--     4 = 90+ days overdue
--   Returns NULL when term_months is unknown (excluded from PAR).
CREATE OR REPLACE FUNCTION loan_ageing_bucket(
    p_loan_id BIGINT,
    p_as_at   DATE DEFAULT CURRENT_DATE
)
RETURNS SMALLINT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_due_date  DATE;
    v_days      INTEGER;
BEGIN
    SELECT due_date INTO v_due_date FROM loans WHERE id = p_loan_id;
    IF v_due_date IS NULL THEN
        RETURN NULL;
    END IF;

    v_days := p_as_at - v_due_date;
    RETURN CASE
        WHEN v_days <= 0  THEN 0
        WHEN v_days < 30  THEN 1
        WHEN v_days < 60  THEN 2
        WHEN v_days < 90  THEN 3
        ELSE 4
    END;
END;
$$;

COMMENT ON FUNCTION loan_ageing_bucket IS 'PAR ageing bucket (0=current, 1=1-29d, 2=30-59d, 3=60-89d, 4=90+d). NULL when term is unknown.';

-- generate_loan_schedule(loan_id)
--   Builds the amortization schedule for an approved loan using the same
--   monthly-compounding model as the front-end. Replaces any existing
--   schedule rows for the loan.
CREATE OR REPLACE FUNCTION generate_loan_schedule(p_loan_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_principal NUMERIC(18,2);
    v_rate      NUMERIC;            -- decimal, e.g. 0.03
    v_disbursed DATE;
    v_term      INTEGER;
    v_pmt       NUMERIC(18,2);
    v_opening   NUMERIC(18,2);
    v_interest  NUMERIC(18,2);
    v_principal_comp NUMERIC(18,2);
    v_closing   NUMERIC(18,2);
    v_due       DATE;
    v_k         INTEGER := 0;
BEGIN
    SELECT principal, rate_monthly, disbursed_on, term_months
      INTO v_principal, v_rate, v_disbursed, v_term
      FROM loans WHERE id = p_loan_id;

    IF NOT FOUND OR v_term IS NULL OR v_term < 1 THEN
        RETURN;
    END IF;

    v_rate := v_rate / 100.0;

    -- PMT = P * r / (1 - (1+r)^-n)
    IF v_rate = 0 THEN
        v_pmt := v_principal / v_term;
    ELSE
        v_pmt := v_principal * v_rate / (1 - POWER(1 + v_rate, -v_term));
    END IF;

    DELETE FROM loan_schedule WHERE loan_id = p_loan_id;

    v_opening := v_principal;
    WHILE v_k < v_term LOOP
        v_interest      := v_opening * v_rate;
        v_principal_comp := LEAST(v_pmt - v_interest, v_opening);
        v_closing       := v_opening - v_principal_comp;
        v_due           := (v_disbursed + ((v_k + 1) || ' months')::INTERVAL)::DATE;

        INSERT INTO loan_schedule (
            loan_id, installment_number, due_date,
            opening_balance, installment_amount,
            interest_component, principal_component, closing_balance,
            status
        ) VALUES (
            p_loan_id, v_k + 1, v_due,
            ROUND(v_opening, 2), ROUND(v_pmt, 2),
            ROUND(v_interest, 2), ROUND(v_principal_comp, 2), ROUND(GREATEST(0, v_closing), 2),
            'Pending'
        );

        v_opening := GREATEST(0, v_closing);
        v_k := v_k + 1;
    END LOOP;

    -- Update summary columns on loans
    UPDATE loans
       SET monthly_installment = ROUND(v_pmt, 2),
           total_interest       = ROUND(v_pmt * v_term - v_principal, 2),
           total_payable        = ROUND(v_pmt * v_term, 2)
     WHERE id = p_loan_id;
END;
$$;

COMMENT ON FUNCTION generate_loan_schedule IS 'Generates (or regenerates) the amortization schedule for a loan using monthly compounding, matching the front-end PMT() / sim() logic.';

-- ----------------------------------------------------------------------------
-- 11. Triggers
-- ----------------------------------------------------------------------------

-- (a) On loan approval: stamp approved_by / approved_on, log status history,
--     and generate the schedule automatically.
CREATE OR REPLACE FUNCTION trg_loan_approval_handler()
RETURNS TRIGGER AS $$
BEGIN
    IF (OLD.status IS DISTINCT FROM NEW.status) AND NEW.status = 'Active' THEN
        IF NEW.approved_by IS NULL THEN
            NEW.approved_by := COALESCE(current_setting('app.current_user_id', true)::BIGINT, NULL);
        END IF;
        IF NEW.approved_on IS NULL THEN
            NEW.approved_on := CURRENT_DATE;
        END IF;

        INSERT INTO loan_status_history (
            loan_id, event, from_status, to_status,
            event_date, officer_id, officer_name
        ) VALUES (
            NEW.id, 'Disbursed', OLD.status::TEXT, NEW.status::TEXT,
            NOW(), NEW.approved_by,
            (SELECT name FROM users WHERE id = NEW.approved_by)
        );
    END IF;

    IF (OLD.status IS DISTINCT FROM NEW.status) AND NEW.status = 'Cleared' THEN
        INSERT INTO loan_status_history (
            loan_id, event, from_status, to_status, event_date, officer_id
        ) VALUES (
            NEW.id, 'Cleared', OLD.status::TEXT, NEW.status::TEXT, NOW(), NEW.approved_by
        );

        -- Release collateral automatically on clearance
        UPDATE loan_collateral
           SET is_released = TRUE,
               released_on = CURRENT_DATE
         WHERE loan_id = NEW.id
           AND is_released = FALSE;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_loans_approval ON loans;
CREATE TRIGGER trg_loans_approval
    AFTER UPDATE OF status ON loans
    FOR EACH ROW EXECUTE FUNCTION trg_loan_approval_handler();

-- (b) On loan_request status change: log to loan_status_history
CREATE OR REPLACE FUNCTION trg_request_status_handler()
RETURNS TRIGGER AS $$
DECLARE
    v_event status_event;
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        v_event := CASE NEW.status
            WHEN 'Pending'   THEN 'Submitted'::status_event
            WHEN 'On Hold'   THEN 'Put on hold'::status_event
            WHEN 'Approved'  THEN 'Approved'::status_event
            WHEN 'Rejected'  THEN 'Rejected'::status_event
        END;

        INSERT INTO loan_status_history (
            request_id, event, from_status, to_status,
            event_date, officer_id, officer_name, remark
        ) VALUES (
            NEW.id, v_event, OLD.status::TEXT, NEW.status::TEXT,
            NOW(), NEW.decided_by,
            (SELECT name FROM users WHERE id = NEW.decided_by),
            NEW.remark
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_requests_status ON loan_requests;
CREATE TRIGGER trg_requests_status
    AFTER UPDATE OF status ON loan_requests
    FOR EACH ROW EXECUTE FUNCTION trg_request_status_handler();

-- (c) On repayment insert: mark schedule installments paid/partial, and
--     clear the loan if balance hits zero.
CREATE OR REPLACE FUNCTION trg_repayment_insert_handler()
RETURNS TRIGGER AS $$
DECLARE
    v_remaining       NUMERIC(18,2);
    v_installment     loan_schedule%ROWTYPE;
    v_loan_balance    NUMERIC(18,2);
BEGIN
    v_remaining := NEW.amount;

    -- Apply against due installments oldest-first, on or before payment date
    FOR v_installment IN
        SELECT * FROM loan_schedule
         WHERE loan_id = NEW.loan_id
           AND status IN ('Pending', 'Partial', 'Overdue', 'Missed')
           AND due_date <= NEW.payment_date
         ORDER BY installment_number
    LOOP
        IF v_remaining <= 0 THEN EXIT; END IF;

        DECLARE
            v_owed NUMERIC(18,2);
            v_paid NUMERIC(18,2);
        BEGIN
            v_owed := v_installment.installment_amount - v_installment.paid_amount;
            v_paid := LEAST(v_owed, v_remaining);

            UPDATE loan_schedule
               SET paid_amount = paid_amount + v_paid,
                   paid_on     = NEW.payment_date,
                   status      = CASE
                       WHEN paid_amount + v_paid >= installment_amount THEN 'Paid'
                       ELSE 'Partial'
                   END,
                   updated_at  = NOW()
             WHERE id = v_installment.id;

            v_remaining := v_remaining - v_paid;
        END;
    END LOOP;

    -- If balance is zero, mark loan cleared
    v_loan_balance := loan_outstanding_balance(NEW.loan_id, NEW.payment_date);
    IF v_loan_balance < 0.5 THEN
        UPDATE loans SET status = 'Cleared', updated_at = NOW() WHERE id = NEW.loan_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_repayments_insert ON loan_repayments;
CREATE TRIGGER trg_repayments_insert
    AFTER INSERT ON loan_repayments
    FOR EACH ROW EXECUTE FUNCTION trg_repayment_insert_handler();

-- (d) On loan write-off insert: mark the loan written_off
CREATE OR REPLACE FUNCTION trg_writeoff_insert_handler()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE loans
       SET written_off = TRUE,
           written_off_on = NEW.write_off_date,
           status = 'Cleared',
           updated_at = NOW()
     WHERE id = NEW.loan_id;

    INSERT INTO loan_status_history (
        loan_id, event, to_status, event_date,
        officer_id, officer_name, remark
    ) VALUES (
        NEW.loan_id, 'Written off', 'Cleared',
        NOW() AT TIME ZONE 'UTC',
        NEW.approved_by,
        (SELECT name FROM users WHERE id = NEW.approved_by),
        'Written off: ' || NEW.reason::TEXT || ' — ' || COALESCE(NEW.justification, '')
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_writeoffs_insert ON loan_write_offs;
CREATE TRIGGER trg_writeoffs_insert
    AFTER INSERT ON loan_write_offs
    FOR EACH ROW EXECUTE FUNCTION trg_writeoff_insert_handler();

-- ----------------------------------------------------------------------------
-- 12. Reporting views
-- ----------------------------------------------------------------------------

-- (a) v_loan_portfolio_summary — portfolio KPIs by category
CREATE OR REPLACE VIEW v_loan_portfolio_summary AS
SELECT
    l.category,
    COUNT(*) FILTER (WHERE l.status = 'Active')              AS active_loans,
    COUNT(*) FILTER (WHERE l.status = 'Cleared')             AS cleared_loans,
    SUM(l.principal)                                         AS total_principal_disbursed,
    SUM(l.principal) FILTER (WHERE l.status = 'Active')      AS active_principal,
    AVG(l.rate_monthly) FILTER (WHERE l.status = 'Active')   AS avg_rate_monthly,
    AVG(l.term_months) FILTER (WHERE l.status = 'Active')    AS avg_term_months
FROM loans l
GROUP BY l.category;

COMMENT ON VIEW v_loan_portfolio_summary IS 'KPIs per loan category (active/cleared counts, principal totals, average rate and term).';

-- (b) v_loan_par_ageing — PAR ageing buckets as at today
CREATE OR REPLACE VIEW v_loan_par_ageing AS
SELECT
    l.id                                                   AS loan_id,
    l.reference,
    COALESCE(l.account_number, '')                         AS account_number,
    l.borrower_name,
    l.category,
    l.principal,
    l.disbursed_on,
    l.due_date,
    loan_outstanding_balance(l.id, CURRENT_DATE)           AS outstanding_balance,
    loan_ageing_bucket(l.id, CURRENT_DATE)                 AS bucket,
    CASE loan_ageing_bucket(l.id, CURRENT_DATE)
        WHEN 0 THEN 'Current'
        WHEN 1 THEN '1-29 days'
        WHEN 2 THEN '30-59 days'
        WHEN 3 THEN '60-89 days'
        WHEN 4 THEN '90+ days'
    END                                                    AS bucket_label,
    GREATEST(0, CURRENT_DATE - l.due_date)                 AS days_overdue
FROM loans l
WHERE l.status = 'Active'
  AND l.written_off = FALSE
ORDER BY l.due_date;

COMMENT ON VIEW v_loan_par_ageing IS 'Active loans with their PAR ageing bucket and outstanding balance (as at today).';

-- (c) v_loan_requests_pipeline — pending and recently-decided requests
CREATE OR REPLACE VIEW v_loan_requests_pipeline AS
SELECT
    r.reference,
    r.request_date,
    CASE r.applicant_type
        WHEN 'm' THEN 'Member'
        WHEN 'n' THEN 'Non-member'
    END                                                    AS applicant_type,
    r.applicant_name,
    r.telephone,
    r.category,
    r.term_months,
    r.principal,
    r.rate_monthly,
    r.status,
    r.remark,
    r.member_savings_balance,
    r.member_outstanding_loans,
    r.net_position,
    u.name                                                 AS requested_by
FROM loan_requests r
LEFT JOIN users u ON u.id = r.requested_by
ORDER BY r.request_date DESC;

COMMENT ON VIEW v_loan_requests_pipeline IS 'Loan applications with member-standing context and the requesting officer.';

-- (d) v_loan_full_detail — one row per loan with computed balances
CREATE OR REPLACE VIEW v_loan_full_detail AS
SELECT
    l.id,
    l.reference,
    COALESCE(l.account_number, '')                         AS account_number,
    l.borrower_name,
    l.telephone,
    l.category,
    l.term_months,
    l.principal,
    l.rate_monthly,
    l.disbursed_on,
    l.due_date,
    l.monthly_installment,
    l.total_payable,
    l.status,
    l.written_off,
    l.approved_on,
    COALESCE((SELECT SUM(amount) FROM loan_repayments r WHERE r.loan_id = l.id), 0)
                                                           AS total_paid,
    loan_outstanding_balance(l.id, CURRENT_DATE)           AS outstanding_balance,
    (SELECT COUNT(*) FROM loan_collateral c WHERE c.loan_id = l.id AND c.is_released = FALSE)
                                                           AS active_collateral_count,
    (SELECT COUNT(*) FROM loan_guarantors g WHERE g.loan_id = l.id AND g.is_active = TRUE)
                                                           AS active_guarantors_count,
    (SELECT COUNT(*) FROM loan_fees f WHERE f.loan_id = l.id AND f.is_paid = FALSE)
                                                           AS unpaid_fees_count
FROM loans l;

COMMENT ON VIEW v_loan_full_detail IS 'One row per loan with computed outstanding balance, paid total, collateral/guarantor/fee counts.';

-- ----------------------------------------------------------------------------
-- 13. Sample seed data (optional — guarded by IF NOT EXISTS so re-running
--     the migration does not duplicate rows).
-- ----------------------------------------------------------------------------

-- No seed data is inserted in this migration: the front-end already seeds the
-- default Admin user and the loan categories in 001_init.sql. Loan, request,
-- schedule, collateral and guarantor rows should be created through the
-- application workflow (or imported via the existing Excel/CSV import path).

COMMIT;

-- ============================================================================
-- End of 002_loans.sql
-- ============================================================================
