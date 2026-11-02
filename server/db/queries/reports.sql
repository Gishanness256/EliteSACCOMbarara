-- Regulatory reporting helpers for Elite SACCO Mbarara.
-- Designed to work with:
--   - members
--   - savings_transactions
--   - loans
--   - loan_repayments
--   - regulatory_return_templates
--   - regulatory_snapshots
--
-- Functions included:
--   1) build_regulatory_snapshot(year, month)
--   2) persist_regulatory_snapshot(...)
--   3) regulatory_snapshot_summary(...)
--
-- These are intended to power the API endpoints:
--   GET /api/v1/regulatory/snapshot/:year/:month
--   POST /api/v1/regulatory/persist

-- ============================================================
-- Build a snapshot JSON for a given month.
-- Returns a JSONB object with summary totals and KPIs.
-- ============================================================

CREATE OR REPLACE FUNCTION build_regulatory_snapshot(
  p_year INTEGER,
  p_month INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_month_start DATE;
  v_month_end DATE;
  v_member_count INTEGER;
  v_active_members INTEGER;
  v_new_members INTEGER;
  v_total_savings_deposit NUMERIC(14,2);
  v_total_savings_withdrawal NUMERIC(14,2);
  v_net_savings NUMERIC(14,2);
  v_total_disbursed NUMERIC(14,2);
  v_total_repayments NUMERIC(14,2);
  v_outstanding_loans NUMERIC(14,2);
  v_active_loans INTEGER;
  v_current_loans INTEGER;
  v_30_days NUMERIC(14,2);
  v_60_days NUMERIC(14,2);
  v_90_days NUMERIC(14,2);
  v_over_90_days NUMERIC(14,2);
  v_snapshot JSONB;
BEGIN
  IF p_year IS NULL OR p_month IS NULL THEN
    RAISE EXCEPTION 'year and month are required';
  END IF;

  IF p_month < 1 OR p_month > 12 THEN
    RAISE EXCEPTION 'month must be between 1 and 12';
  END IF;

  v_month_start := make_date(p_year, p_month, 1);
  v_month_end := (v_month_start + INTERVAL '1 month - 1 day')::DATE;

  SELECT COUNT(*)
    INTO v_member_count
  FROM members
  WHERE is_active = TRUE;

  SELECT COUNT(*)
    INTO v_active_members
  FROM members
  WHERE is_active = TRUE;

  SELECT COUNT(*)
    INTO v_new_members
  FROM members
  WHERE created_at >= v_month_start
    AND created_at < (v_month_end + INTERVAL '1 day');

  SELECT COALESCE(SUM(CASE WHEN direction = 'Deposit' THEN amount ELSE 0 END), 0)
    INTO v_total_savings_deposit
  FROM savings_transactions
  WHERE occurred_at >= v_month_start
    AND occurred_at < (v_month_end + INTERVAL '1 day');

  SELECT COALESCE(SUM(CASE WHEN direction = 'Withdrawal' THEN amount ELSE 0 END), 0)
    INTO v_total_savings_withdrawal
  FROM savings_transactions
  WHERE occurred_at >= v_month_start
    AND occurred_at < (v_month_end + INTERVAL '1 day');

  SELECT COALESCE(SUM(principal), 0)
    INTO v_total_disbursed
  FROM loans
  WHERE disbursed_on >= v_month_start
    AND disbursed_on <= v_month_end;

  SELECT COALESCE(SUM(amount), 0)
    INTO v_total_repayments
  FROM loan_repayments
  WHERE payment_date >= v_month_start
    AND payment_date <= v_month_end;

  SELECT COALESCE(SUM(principal), 0)
    INTO v_outstanding_loans
  FROM loans
  WHERE status IN ('Active', 'Restructured');

  SELECT COUNT(*)
    INTO v_active_loans
  FROM loans
  WHERE status = 'Active';

  SELECT COUNT(*)
    INTO v_current_loans
  FROM loans
  WHERE status IN ('Active', 'Restructured');

  -- Portfolio at Risk approximation based on outstanding balances
  SELECT COALESCE(SUM(CASE WHEN loan_ageing_bucket(id, v_month_end) = 'Current' THEN loan_outstanding_balance(id, v_month_end) ELSE 0 END), 0)
    INTO v_30_days
  FROM loans
  WHERE status IN ('Active', 'Restructured');

  SELECT COALESCE(SUM(CASE WHEN loan_ageing_bucket(id, v_month_end) = '31-60 days' THEN loan_outstanding_balance(id, v_month_end) ELSE 0 END), 0)
    INTO v_60_days
  FROM loans
  WHERE status IN ('Active', 'Restructured');

  SELECT COALESCE(SUM(CASE WHEN loan_ageing_bucket(id, v_month_end) = '61-90 days' THEN loan_outstanding_balance(id, v_month_end) ELSE 0 END), 0)
    INTO v_90_days
  FROM loans
  WHERE status IN ('Active', 'Restructured');

  SELECT COALESCE(SUM(CASE WHEN loan_ageing_bucket(id, v_month_end) IN ('121+ days') THEN loan_outstanding_balance(id, v_month_end) ELSE 0 END), 0)
    INTO v_over_90_days
  FROM loans
  WHERE status IN ('Active', 'Restructured');

  v_net_savings := COALESCE(v_total_savings_deposit, 0) - COALESCE(v_total_savings_withdrawal, 0);

  v_snapshot := jsonb_build_object(
    'period', to_char(v_month_start, 'YYYY-MM'),
    'month_start', v_month_start::TEXT,
    'month_end', v_month_end::TEXT,
    'members', jsonb_build_object(
      'total', COALESCE(v_member_count, 0),
      'active', COALESCE(v_active_members, 0),
      'new_this_month', COALESCE(v_new_members, 0)
    ),
    'savings', jsonb_build_object(
      'deposits', COALESCE(v_total_savings_deposit, 0),
      'withdrawals', COALESCE(v_total_savings_withdrawal, 0),
      'net_change', COALESCE(v_net_savings, 0)
    ),
    'loans', jsonb_build_object(
      'disbursed_this_month', COALESCE(v_total_disbursed, 0),
      'repayments_this_month', COALESCE(v_total_repayments, 0),
      'outstanding', COALESCE(v_outstanding_loans, 0),
      'active_loans', COALESCE(v_active_loans, 0),
      'total_active_or_restructured', COALESCE(v_current_loans, 0)
    ),
    'par', jsonb_build_object(
      'current', COALESCE(v_30_days, 0),
      'days_31_60', COALESCE(v_60_days, 0),
      'days_61_90', COALESCE(v_90_days, 0),
      'days_121_plus', COALESCE(v_over_90_days, 0)
    ),
    'summary', jsonb_build_object(
      'total_members', COALESCE(v_member_count, 0),
      'active_members', COALESCE(v_active_members, 0),
      'total_savings', COALESCE(
        (
          SELECT SUM(CASE WHEN direction = 'Deposit' THEN amount ELSE -amount END)
          FROM savings_transactions
        ),
        0
      ),
      'total_loan_outstanding', COALESCE(v_outstanding_loans, 0),
      'total_loan_repayments', COALESCE(v_total_repayments, 0)
    )
  );

  RETURN v_snapshot;
END;
$$;

-- ============================================================
-- Persist a generated snapshot to regulatory_snapshots.
-- Example:
-- SELECT persist_regulatory_snapshot(
--   2026,
--   11,
--   1,
--   'm',
--   1,
--   3,
--   'Monthly monitoring snapshot'
-- );
-- ============================================================

CREATE OR REPLACE FUNCTION persist_regulatory_snapshot(
  p_year INTEGER,
  p_month INTEGER,
  p_template_id INTEGER,
  p_basis reporting_basis DEFAULT 'm',
  p_n_months INTEGER DEFAULT 1,
  p_generated_by INTEGER DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_snapshot JSONB;
  v_snapshot_id INTEGER;
BEGIN
  IF p_year IS NULL OR p_month IS NULL THEN
    RAISE EXCEPTION 'year and month are required';
  END IF;

  IF p_template_id IS NULL THEN
    RAISE EXCEPTION 'template_id is required';
  END IF;

  v_snapshot := build_regulatory_snapshot(p_year, p_month);

  INSERT INTO regulatory_snapshots (
    year,
    month,
    template_id,
    basis,
    n_months,
    snapshot_json,
    generated_by,
    notes
  )
  VALUES (
    p_year,
    p_month,
    p_template_id,
    p_basis,
    COALESCE(p_n_months, 1),
    v_snapshot,
    p_generated_by,
    p_notes
  )
  RETURNING id INTO v_snapshot_id;

  RETURN v_snapshot_id;
END;
$$;

-- ============================================================
-- Summary helper for a specific period across multiple months.
-- Useful for "quarterly" or "annual" reporting.
-- ============================================================

CREATE OR REPLACE FUNCTION regulatory_snapshot_summary(
  p_year INTEGER,
  p_month INTEGER,
  p_basis reporting_basis DEFAULT 'm'
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_start_month INTEGER;
  v_end_month INTEGER;
  v_months INTEGER;
  v_result JSONB;
BEGIN
  IF p_basis = 'm' THEN
    v_months := 1;
    v_start_month := p_month;
    v_end_month := p_month;
  ELSIF p_basis = 'q' THEN
    v_start_month := CASE
      WHEN p_month IN (1,2,3) THEN 1
      WHEN p_month IN (4,5,6) THEN 4
      WHEN p_month IN (7,8,9) THEN 7
      ELSE 10
    END;
    v_end_month := CASE
      WHEN p_month IN (1,2,3) THEN 3
      WHEN p_month IN (4,5,6) THEN 6
      WHEN p_month IN (7,8,9) THEN 9
      ELSE 12
    END;
    v_months := v_end_month - v_start_month + 1;
  ELSIF p_basis = 'y' THEN
    v_start_month := 1;
    v_end_month := 12;
    v_months := 12;
  ELSE
    RAISE EXCEPTION 'unsupported reporting basis: %', p_basis;
  END IF;

  v_result := jsonb_build_object(
    'basis', p_basis::TEXT,
    'period_start_month', v_start_month,
    'period_end_month', v_end_month,
    'months_covered', v_months,
    'generated_for', to_char(make_date(p_year, 1, 1), 'YYYY')
  );

  RETURN v_result;
END;
$$;

-- ============================================================
-- Example queries
-- ============================================================

-- View a generated monthly snapshot:
-- SELECT build_regulatory_snapshot(2026, 11);

-- Persist a snapshot:
-- SELECT persist_regulatory_snapshot(
--   2026,
--   11,
--   1,
--   'm',
--   1,
--   3,
--   'Monthly snapshot generated for audit review'
-- );

-- Read previously saved snapshots:
-- SELECT *
-- FROM regulatory_snapshots
-- ORDER BY generated_at DESC
-- LIMIT 20;
