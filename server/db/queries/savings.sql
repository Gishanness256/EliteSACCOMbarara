-- Savings helpers for Elite SACCO Mbarara.
-- Supports balances, references, and summary reporting for member account activity.

-- ============================================================
-- Account-level balance helper
-- ============================================================

CREATE OR REPLACE FUNCTION savings_balance_for_account(p_account_number TEXT)
RETURNS NUMERIC(14,2)
LANGUAGE plpgsql
AS $$
DECLARE
  v_total NUMERIC(14,2);
BEGIN
  SELECT COALESCE(
    SUM(
      CASE
        WHEN direction = 'Deposit' THEN amount
        ELSE -amount
      END
    ),
    0
  )
    INTO v_total
  FROM savings_transactions
  WHERE account_number = p_account_number;

  RETURN ROUND(COALESCE(v_total, 0), 2);
END;
$$;

-- ============================================================
-- Generate next savings transaction reference
-- Example: SV-000001
-- ============================================================

CREATE OR REPLACE FUNCTION next_savings_reference()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_next INTEGER;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(reference FROM 4) AS INTEGER)), 0) + 1
    INTO v_next
  FROM savings_transactions
  WHERE reference LIKE 'SV-%';

  RETURN 'SV-' || LPAD(v_next::TEXT, 6, '0');
END;
$$;

-- ============================================================
-- Member savings summary view
-- Returns per-member deposits, withdrawals, balance, and latest activity.
-- ============================================================

CREATE OR REPLACE VIEW v_member_savings_summary AS
SELECT
  m.id,
  m.account_number,
  m.first_name,
  m.last_name,
  m.telephone,
  m.email,

  COALESCE(
    (
      SELECT SUM(CASE WHEN st.direction = 'Deposit' THEN st.amount ELSE 0 END)
      FROM savings_transactions st
      WHERE st.account_number = m.account_number
    ),
    0
  ) AS total_deposits,

  COALESCE(
    (
      SELECT SUM(CASE WHEN st.direction = 'Withdrawal' THEN st.amount ELSE 0 END)
      FROM savings_transactions st
      WHERE st.account_number = m.account_number
    ),
    0
  ) AS total_withdrawals,

  COALESCE(
    (
      SELECT SUM(
        CASE
          WHEN st.direction = 'Deposit' THEN st.amount
          ELSE -st.amount
        END
      )
      FROM savings_transactions st
      WHERE st.account_number = m.account_number
    ),
    0
  ) AS current_balance,

  COALESCE(
    (
      SELECT MAX(st.occurred_at)
      FROM savings_transactions st
      WHERE st.account_number = m.account_number
    ),
    NULL
  ) AS last_transaction_at

FROM members m;

-- ============================================================
-- Savings statement for a member over a period
-- ============================================================

CREATE OR REPLACE FUNCTION savings_statement(
  p_account_number TEXT,
  p_from DATE DEFAULT NULL,
  p_to DATE DEFAULT NULL
)
RETURNS TABLE (
  reference TEXT,
  account_number TEXT,
  direction TEXT,
  amount NUMERIC,
  occurred_at TIMESTAMPTZ,
  channel TEXT,
  slip_number TEXT,
  remarks TEXT,
  officer_initials TEXT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    st.reference,
    st.account_number,
    st.direction::TEXT,
    st.amount,
    st.occurred_at,
    st.channel::TEXT,
    st.slip_number,
    st.remarks,
    st.officer_initials
  FROM savings_transactions st
  WHERE st.account_number = p_account_number
    AND (
      p_from IS NULL OR st.occurred_at::DATE >= p_from
    )
    AND (
      p_to IS NULL OR st.occurred_at::DATE <= p_to
    )
  ORDER BY st.occurred_at DESC;
END;
$$;

-- ============================================================
-- Summary stats across all savings transactions
-- ============================================================

CREATE OR REPLACE FUNCTION savings_summary()
RETURNS TABLE (
  total_accounts BIGINT,
  total_deposits NUMERIC,
  total_withdrawals NUMERIC,
  total_net NUMERIC
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(DISTINCT account_number)::BIGINT AS total_accounts,
    COALESCE(SUM(CASE WHEN direction = 'Deposit' THEN amount ELSE 0 END), 0)::NUMERIC AS total_deposits,
    COALESCE(SUM(CASE WHEN direction = 'Withdrawal' THEN amount ELSE 0 END), 0)::NUMERIC AS total_withdrawals,
    COALESCE(SUM(CASE WHEN direction = 'Deposit' THEN amount ELSE -amount END), 0)::NUMERIC AS total_net
  FROM savings_transactions;
END;
$$;

-- ============================================================
-- Example queries
-- ============================================================

-- Current balance for one member:
-- SELECT savings_balance_for_account('ES-M 000001');

-- Next reference:
-- SELECT next_savings_reference();

-- Member savings summary:
-- SELECT *
-- FROM v_member_savings_summary
-- ORDER BY account_number;

-- Savings activity for a date range:
-- SELECT *
-- FROM savings_statement('ES-M 000001', '2026-01-01', '2026-12-31');

-- Global savings summary:
-- SELECT *
-- FROM savings_summary();
