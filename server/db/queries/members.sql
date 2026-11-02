-- Member account helpers and summary queries for Elite SACCO Mbarara.
-- These queries complement the core members table from schema.sql.

-- ============================================================
-- Helper: generate the next account number for a member
-- Example: ES-M 000001
-- ============================================================

CREATE OR REPLACE FUNCTION next_member_account_number(p_gender member_gender)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_next_seq INTEGER;
BEGIN
  SELECT COALESCE(
           MAX(CAST(SUBSTRING(account_number FROM POSITION(' ' IN account_number) + 1) AS INTEGER)),
           0
         ) + 1
    INTO v_next_seq
  FROM members
  WHERE account_number LIKE 'ES-' || p_gender::text || ' %';

  RETURN 'ES-' || p_gender::text || ' ' || LPAD(v_next_seq::TEXT, 6, '0');
END;
$$;

-- ============================================================
-- Summary view for member dashboard/search
-- Includes savings balance and loans outstanding, if the loan helpers exist.
-- ============================================================

CREATE OR REPLACE VIEW v_member_summary AS
SELECT
  m.id,
  m.account_number,
  m.first_name,
  m.last_name,
  m.gender::TEXT AS gender,
  m.date_of_birth,
  m.telephone,
  m.email,
  m.nin,
  m.address,
  m.is_active,
  m.created_at,
  m.updated_at,

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
  ) AS savings_balance,

  COALESCE(
    (
      SELECT SUM(loan_outstanding_balance(l.id, CURRENT_DATE))
      FROM loans l
      WHERE l.account_number = m.account_number
        AND l.status IN ('Active', 'Restructured')
    ),
    0
  ) AS outstanding_loans,

  COALESCE(
    (
      SELECT COUNT(*)
      FROM loans l
      WHERE l.account_number = m.account_number
        AND l.status = 'Active'
    ),
    0
  ) AS active_loans_count

FROM members m;

-- ============================================================
-- Searchable member query
-- Use this from application code to filter by name or account number.
-- Example:
-- SELECT *
-- FROM v_member_summary
-- WHERE LOWER(first_name || ' ' || last_name || ' ' || account_number) LIKE LOWER('%john%')
-- ORDER BY account_number
-- LIMIT 100;
-- ============================================================

-- ============================================================
-- Member total counts
-- ============================================================

CREATE OR REPLACE FUNCTION member_stats()
RETURNS TABLE (
  total_members BIGINT,
  active_members BIGINT,
  inactive_members BIGINT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::BIGINT AS total_members,
    COUNT(*) FILTER (WHERE is_active = TRUE)::BIGINT AS active_members,
    COUNT(*) FILTER (WHERE is_active = FALSE)::BIGINT AS inactive_members
  FROM members;
END;
$$;

-- ============================================================
-- Member profile lookup by account number
-- Example:
-- SELECT *
-- FROM member_profile('ES-M 000001');
-- ============================================================

CREATE OR REPLACE FUNCTION member_profile(p_account_number TEXT)
RETURNS TABLE (
  id INTEGER,
  account_number TEXT,
  first_name TEXT,
  last_name TEXT,
  gender TEXT,
  date_of_birth DATE,
  telephone TEXT,
  email TEXT,
  nin TEXT,
  address TEXT,
  is_active BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  savings_balance NUMERIC,
  outstanding_loans NUMERIC,
  active_loans_count BIGINT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.account_number,
    m.first_name,
    m.last_name,
    m.gender::TEXT,
    m.date_of_birth,
    m.telephone,
    m.email,
    m.nin,
    m.address,
    m.is_active,
    m.created_at,
    m.updated_at,
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
    )::NUMERIC,
    COALESCE(
      (
        SELECT SUM(loan_outstanding_balance(l.id, CURRENT_DATE))
        FROM loans l
        WHERE l.account_number = m.account_number
          AND l.status IN ('Active', 'Restructured')
      ),
      0
    )::NUMERIC,
    COALESCE(
      (
        SELECT COUNT(*)
        FROM loans l
        WHERE l.account_number = m.account_number
          AND l.status = 'Active'
      ),
      0
    )::BIGINT
  FROM members m
  WHERE m.account_number = p_account_number
  LIMIT 1;
END;
$$;

-- ============================================================
-- Useful examples
-- ============================================================

-- Generate the next member account number:
-- SELECT next_member_account_number('M');

-- View member summary:
-- SELECT *
-- FROM v_member_summary
-- ORDER BY account_number;

-- Show stats:
-- SELECT *
-- FROM member_stats();

-- Get one member profile:
-- SELECT *
-- FROM member_profile('ES-M 000001');
