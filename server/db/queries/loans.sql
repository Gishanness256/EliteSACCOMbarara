-- Loan calculations and amortization support for Elite SACCO Mbarara.
-- Includes:
--   - schedule generation
--   - outstanding balance
--   - aging bucket
--   - monthly installment calculation

-- ------------------------------------------------------------
-- Loan schedule table
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS loan_payment_schedule (
  id SERIAL PRIMARY KEY,
  loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  due_date DATE NOT NULL,
  installment_no INTEGER NOT NULL,
  opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  interest_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  principal_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_payment NUMERIC(14,2) NOT NULL DEFAULT 0,
  closing_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  UNIQUE (loan_id, installment_no)
);

CREATE INDEX IF NOT EXISTS idx_loan_payment_schedule_loan_id
  ON loan_payment_schedule (loan_id);

CREATE INDEX IF NOT EXISTS idx_loan_payment_schedule_due_date
  ON loan_payment_schedule (due_date);

-- ------------------------------------------------------------
-- Monthly installment calculator
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION calculate_monthly_installment(
  p_principal NUMERIC(14,2),
  p_rate_monthly NUMERIC(8,4),
  p_term_months INTEGER
)
RETURNS NUMERIC(14,2)
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_term_months IS NULL OR p_term_months <= 0 THEN
    RETURN 0;
  END IF;

  IF p_principal IS NULL OR p_principal <= 0 THEN
    RETURN 0;
  END IF;

  -- rate_monthly is expected as a decimal fraction, e.g. 0.02 => 2%
  IF p_rate_monthly IS NULL OR p_rate_monthly <= 0 THEN
    RETURN ROUND(p_principal / p_term_months, 2);
  END IF;

  RETURN ROUND(
    (p_principal * p_rate_monthly) /
    (1 - POWER(1 + p_rate_monthly, -p_term_months)),
    2
  );
END;
$$;

-- ------------------------------------------------------------
-- Generate amortization schedule for a loan
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION generate_loan_schedule(p_loan_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_loan RECORD;
  v_balance NUMERIC(14,2);
  v_rate NUMERIC(8,4);
  v_term INTEGER;
  v_payment NUMERIC(14,2);
  v_interest NUMERIC(14,2);
  v_principal_component NUMERIC(14,2);
  v_due_date DATE;
  v_installment INTEGER;
BEGIN
  SELECT *
    INTO v_loan
    FROM loans
   WHERE id = p_loan_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Loan not found: %', p_loan_id;
  END IF;

  v_rate := COALESCE(v_loan.rate_monthly, 0);
  v_term := COALESCE(v_loan.term_months, 0);
  v_balance := COALESCE(v_loan.principal, 0);

  IF v_term <= 0 THEN
    RETURN;
  END IF;

  IF v_loan.monthly_installment IS NULL OR v_loan.monthly_installment <= 0 THEN
    v_payment := calculate_monthly_installment(v_loan.principal, v_rate, v_term);
    UPDATE loans
       SET monthly_installment = v_payment,
           total_payable = v_payment * v_term,
           updated_at = NOW()
     WHERE id = p_loan_id;
  ELSE
    v_payment := v_loan.monthly_installment;
  END IF;

  DELETE FROM loan_payment_schedule WHERE loan_id = p_loan_id;

  FOR v_installment IN 1..v_term LOOP
    v_due_date := v_loan.disbursed_on + (v_installment * INTERVAL '1 month');

    IF v_balance <= 0 THEN
      INSERT INTO loan_payment_schedule (
        loan_id,
        due_date,
        installment_no,
        opening_balance,
        interest_amount,
        principal_amount,
        total_payment,
        closing_balance
      )
      VALUES (
        p_loan_id,
        v_due_date,
        v_installment,
        0,
        0,
        0,
        0,
        0
      );
      CONTINUE;
    END IF;

    v_interest := ROUND(v_balance * v_rate, 2);
    v_principal_component := ROUND(v_payment - v_interest, 2);

    IF v_principal_component > v_balance THEN
      v_principal_component := v_balance;
    END IF;

    IF v_principal_component < 0 THEN
      v_principal_component := 0;
    END IF;

    v_balance := ROUND(v_balance - v_principal_component, 2);

    INSERT INTO loan_payment_schedule (
      loan_id,
      due_date,
      installment_no,
      opening_balance,
      interest_amount,
      principal_amount,
      total_payment,
      closing_balance
    )
    VALUES (
      p_loan_id,
      v_due_date,
      v_installment,
      ROUND(v_loan.principal - (v_loan.principal - v_balance) + 0, 2),  -- safe placeholder; overwritten below
      v_interest,
      v_principal_component,
      v_payment,
      v_balance
    );

    UPDATE loan_payment_schedule
       SET opening_balance = CASE
         WHEN installment_no = v_installment THEN
           COALESCE(
             (SELECT s.closing_balance
              FROM loan_payment_schedule s
             WHERE s.loan_id = p_loan_id
               AND s.installment_no = v_installment - 1),
             v_loan.principal
           )
         ELSE opening_balance
       END
     WHERE loan_id = p_loan_id
       AND installment_no = v_installment;
  END LOOP;

  UPDATE loans
     SET total_payable = COALESCE(monthly_installment, 0) * term_months,
         updated_at = NOW()
   WHERE id = p_loan_id;
END;
$$;

-- ------------------------------------------------------------
-- Outstanding balance as of a date
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION loan_outstanding_balance(
  p_loan_id INTEGER,
  p_as_of_date DATE DEFAULT CURRENT_DATE
)
RETURNS NUMERIC(14,2)
LANGUAGE plpgsql
AS $$
DECLARE
  v_loan RECORD;
  v_total_paid NUMERIC(14,2);
  v_balance NUMERIC(14,2);
BEGIN
  SELECT *
    INTO v_loan
    FROM loans
   WHERE id = p_loan_id;

  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(SUM(amount), 0)
    INTO v_total_paid
    FROM loan_repayments
   WHERE loan_id = p_loan_id
     AND payment_date <= COALESCE(p_as_of_date, CURRENT_DATE);

  v_balance := COALESCE(v_loan.principal, 0) - v_total_paid;

  IF v_balance < 0 THEN
    RETURN 0;
  END IF;

  RETURN ROUND(v_balance, 2);
END;
$$;

-- ------------------------------------------------------------
-- Aging bucket helper
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION loan_ageing_bucket(
  p_loan_id INTEGER,
  p_as_of_date DATE DEFAULT CURRENT_DATE
)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_loan RECORD;
  v_latest_due_date DATE;
  v_days_late INTEGER;
  v_outstanding NUMERIC(14,2);
BEGIN
  SELECT *
    INTO v_loan
    FROM loans
   WHERE id = p_loan_id;

  IF NOT FOUND THEN
    RETURN 'Unknown';
  END IF;

  v_outstanding := loan_outstanding_balance(p_loan_id, p_as_of_date);

  IF v_outstanding <= 0 THEN
    RETURN 'Current';
  END IF;

  SELECT MAX(due_date)
    INTO v_latest_due_date
    FROM loan_payment_schedule
   WHERE loan_id = p_loan_id
     AND due_date <= COALESCE(p_as_of_date, CURRENT_DATE);

  IF v_latest_due_date IS NULL THEN
    v_latest_due_date := v_loan.disbursed_on;
  END IF;

  v_days_late := DATE_PART('day', COALESCE(p_as_of_date, CURRENT_DATE) - v_latest_due_date);

  IF v_days_late <= 30 THEN
    RETURN 'Current';
  ELSIF v_days_late <= 60 THEN
    RETURN '31-60 days';
  ELSIF v_days_late <= 90 THEN
    RETURN '61-90 days';
  ELSIF v_days_late <= 120 THEN
    RETURN '91-120 days';
  ELSE
    RETURN '121+ days';
  END IF;
END;
$$;

-- ------------------------------------------------------------
-- Example queries
-- ------------------------------------------------------------

-- Generate schedule for a specific loan:
-- SELECT generate_loan_schedule(1);

-- Inspect schedule:
-- SELECT *
-- FROM loan_payment_schedule
-- WHERE loan_id = 1
-- ORDER BY installment_no;

-- Outstanding as of today:
-- SELECT loan_outstanding_balance(1, CURRENT_DATE);

-- Aging bucket:
-- SELECT loan_ageing_bucket(1, CURRENT_DATE);
