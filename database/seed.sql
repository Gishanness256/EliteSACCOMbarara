-- ============================================================================
-- ELITE SACCO MBARARA — DATABASE SEED DATA
-- File: seed.sql
-- Developed by Gisha-Tech Innovations
-- ============================================================================
-- Target RDBMS : MySQL 8.0+ (InnoDB)
-- Depends on  : schema.sql (must be imported first)
-- Optional     : policies.sql (recommended — enforces RLS on writes)
--
-- CONTENTS
--   1. Default roles                    (Admin, Treasurer, Credit
--                                        Supervisor, Credit Officer)
--   2. Default role-permission matrix    (9 permissions × 4 roles)
--   3. First (bootstrap) system admin    (admin@elitesacco.co.ug)
--   4. Institution & system settings     (name, tagline, domain, etc.)
--   5. Loan categories & pricing         (5 products with monthly rates,
--                                        plus non-member surcharge and
--                                        term-adjustment rates)
--   6. Regulator & prudential benchmarks (UMRA + min ratios + PAR caps)
--   7. Loan-loss provision rates         (5 ageing buckets)
--   8. Reference-number prefixes         (SV / LR / LN)
--
-- IDEMPOTENCE
--   Every INSERT uses ON DUPLICATE KEY UPDATE, so this file can be
--   re-run safely without producing duplicate-key errors. The first
--   admin user's password hash is regenerated on each run — replace
--   the placeholder with a real bcrypt hash before going live.
-- ============================================================================

USE `elite_sacco`;
SET NAMES utf8mb4;
SET sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION';

-- ----------------------------------------------------------------------------
-- 1. DEFAULT ROLES
-- ----------------------------------------------------------------------------
-- Four built-in roles matching the Elite SACCO Mbarara dashboard.
-- `is_system = 1` marks them as protected (cannot be deleted via the UI).

INSERT INTO `roles` (`id`, `name`, `description`, `is_system`) VALUES
  (1, 'Admin',             'Full system administrator. Manages users, settings, all modules and regulatory returns.', 1),
  (2, 'Treasurer',          'Manages savings, portfolio (ledger & liquidity) and regulatory returns.',                  1),
  (3, 'Credit Supervisor',  'Supervises loan requests and approvals; sets interest rates; weekly & monthly reports.', 1),
  (4, 'Credit Officer',     'Receives loan requests and acknowledges savings deposits / loan repayments.',              1)
ON DUPLICATE KEY UPDATE
  `description` = VALUES(`description`),
  `is_system`   = VALUES(`is_system`);


-- ----------------------------------------------------------------------------
-- 2. DEFAULT ROLE-PERMISSION MATRIX
-- ----------------------------------------------------------------------------
-- The nine capabilities shown in the Access Levels page of the dashboard.
-- Each row maps a (role, permission_key) pair to a granted/denied flag.
--
-- Permission keys (mirroring schema.sql):
--   approve_loans               — Approve loans
--   acknowledge_savings         — Acknowledge savings / deposits
--   acknowledge_loan_repayments — Acknowledge loan repayments
--   set_interest_rates          — Set interest rates
--   manage_system_users         — Create / remove system users
--   manage_member_accounts      — Create / remove member accounts
--   view_weekly_reports         — Generate weekly reports
--   view_monthly_reports        — Generate monthly reports
--   view_annual_reports         — Generate annual reports
--
-- Summary of the matrix:
--                                  | Admin | Treasurer | CreditSup | CreditOff |
--   approve_loans                  |  yes  |    no     |   yes    |    no     |
--   acknowledge_savings            |  yes  |   yes    |    no    |   yes     |
--   acknowledge_loan_repayments    |  yes  |   yes    |   yes    |   yes     |
--   set_interest_rates             |  yes  |    no    |   yes    |    no     |
--   manage_system_users            |  yes  |    no    |    no    |    no     |
--   manage_member_accounts         |  yes  |    no    |    no    |    no     |
--   view_weekly_reports            |  yes  |   yes    |   yes    |    no     |
--   view_monthly_reports           |  yes  |   yes    |   yes    |    no     |
--   view_annual_reports            |  yes  |   yes    |    no    |    no     |
-- ----------------------------------------------------------------------------

INSERT INTO `role_permissions`
  (`role_id`, `permission_key`, `permission_desc`, `is_granted`) VALUES
  -- ---- Admin (role_id = 1) : all permissions granted ----
  (1, 'approve_loans',               'Approve loans',                  1),
  (1, 'acknowledge_savings',         'Acknowledge savings / deposits', 1),
  (1, 'acknowledge_loan_repayments', 'Acknowledge loan repayments',     1),
  (1, 'set_interest_rates',          'Set interest rates',              1),
  (1, 'manage_system_users',         'Create / remove system users',    1),
  (1, 'manage_member_accounts',      'Create / remove member accounts', 1),
  (1, 'view_weekly_reports',         'Generate weekly reports',         1),
  (1, 'view_monthly_reports',        'Generate monthly reports',        1),
  (1, 'view_annual_reports',         'Generate annual reports',         1),

  -- ---- Treasurer (role_id = 2) ----
  (2, 'approve_loans',               'Approve loans',                  0),
  (2, 'acknowledge_savings',         'Acknowledge savings / deposits', 1),
  (2, 'acknowledge_loan_repayments', 'Acknowledge loan repayments',     1),
  (2, 'set_interest_rates',          'Set interest rates',              0),
  (2, 'manage_system_users',         'Create / remove system users',    0),
  (2, 'manage_member_accounts',      'Create / remove member accounts', 0),
  (2, 'view_weekly_reports',         'Generate weekly reports',         1),
  (2, 'view_monthly_reports',        'Generate monthly reports',        1),
  (2, 'view_annual_reports',         'Generate annual reports',         1),

  -- ---- Credit Supervisor (role_id = 3) ----
  (3, 'approve_loans',               'Approve loans',                  1),
  (3, 'acknowledge_savings',         'Acknowledge savings / deposits', 0),
  (3, 'acknowledge_loan_repayments', 'Acknowledge loan repayments',     1),
  (3, 'set_interest_rates',          'Set interest rates',              1),
  (3, 'manage_system_users',         'Create / remove system users',    0),
  (3, 'manage_member_accounts',      'Create / remove member accounts', 0),
  (3, 'view_weekly_reports',         'Generate weekly reports',         1),
  (3, 'view_monthly_reports',        'Generate monthly reports',        1),
  (3, 'view_annual_reports',         'Generate annual reports',         0),

  -- ---- Credit Officer (role_id = 4) ----
  (4, 'approve_loans',               'Approve loans',                  0),
  (4, 'acknowledge_savings',         'Acknowledge savings / deposits', 1),
  (4, 'acknowledge_loan_repayments', 'Acknowledge loan repayments',     1),
  (4, 'set_interest_rates',          'Set interest rates',              0),
  (4, 'manage_system_users',         'Create / remove system users',    0),
  (4, 'manage_member_accounts',      'Create / remove member accounts', 0),
  (4, 'view_weekly_reports',         'Generate weekly reports',         0),
  (4, 'view_monthly_reports',        'Generate monthly reports',        0),
  (4, 'view_annual_reports',         'Generate annual reports',         0)
ON DUPLICATE KEY UPDATE
  `permission_desc` = VALUES(`permission_desc`),
  `is_granted`      = VALUES(`is_granted`);


-- ----------------------------------------------------------------------------
-- 3. FIRST (BOOTSTRAP) SYSTEM ADMIN USER
-- ----------------------------------------------------------------------------
-- This is the very first account created so that the SACCO can log in and
-- set up the rest of the system. It is marked must_change_pw = 1 so the
-- admin is forced to choose a new password on first login.
--
-- !!! IMPORTANT !!!
-- The password_hash below is a PLACEHOLDER. It is NOT a valid bcrypt hash
-- of any known password. Before going live you MUST replace it with a real
-- hash of a strong, randomly-generated temporary password. For example,
-- using Python's bcrypt library:
--
--     import bcrypt
--     hash = bcrypt.hashpw(b'CHANGE_ME_strong_temp_pw!', bcrypt.gensalt(12))
--     print(hash.decode())     # paste the output below
--
-- Or using the MySQL workbench / mysqlsh:
--
--     mysql> \sql
--     mysql> SET @h = '$2b$12$....real_hash....';
--     mysql> UPDATE users SET password_hash = @h WHERE email='admin@elitesacco.co.ug';
-- ----------------------------------------------------------------------------

INSERT INTO `users`
  (`id`, `full_name`, `login_handle`, `email`, `initials`,
   `role_id`, `password_hash`, `must_change_pw`, `is_active`)
VALUES
  (1,
   'System Admin',
   'admin',
   'admin@elitesacco.co.ug',
   'SA',
   1,
   '$2b$12$REPLACE_WITH_REAL_BCRYPT_HASH_BEFORE_GOING_LIVE',
   1,
   1)
ON DUPLICATE KEY UPDATE
  `full_name`      = VALUES(`full_name`),
  `login_handle`   = VALUES(`login_handle`),
  `initials`       = VALUES(`initials`),
  `role_id`        = VALUES(`role_id`),
  `must_change_pw` = VALUES(`must_change_pw`),
  `is_active`      = VALUES(`is_active`);


-- ----------------------------------------------------------------------------
-- 4. INSTITUTION & SYSTEM SETTINGS
-- ----------------------------------------------------------------------------
-- Single source of truth for institution identity, branding and
-- application defaults. Stored in the `settings` key/value table.

INSERT INTO `settings` (`setting_key`, `setting_value`, `data_type`, `description`) VALUES
  -- ---- Institution identity ----
  ('institution_name',     'Elite SACCO Mbarara',                          'string',  'SACCO display name shown in the header and on reports'),
  ('institution_tagline', 'ELITE SACCO MBARARA, GUARANTEED SUCCESS',       'string',  'SACCO tagline / motto'),
  ('developer',            'Gisha-Tech Innovations',                       'string',  'System developer credit shown in the footer'),
  ('copyright_year',      '2026',                                          'string',  'Copyright year shown in the footer'),

  -- ---- Login / authentication ----
  ('login_domain',            'elitesacco.co.ug',                           'string',  'Email domain appended to login handles (e.g. jane -> jane@elitesacco.co.ug)'),
  ('default_password_length', '6',                                          'integer', 'Minimum password length enforced at create / reset time'),
  ('session_timeout_minutes', '30',                                         'integer', 'Idle session timeout in minutes (enforced by the application, not the DB)'),

  -- ---- Reference-number prefixes ----
  ('savings_ref_prefix',      'SV',                                          'string',  'Prefix for savings transaction references (SV-NNNNNN)'),
  ('loan_request_ref_prefix', 'LR',                                          'string',  'Prefix for loan request references (LR-NNNN)'),
  ('loan_ref_prefix',         'LN',                                          'string',  'Prefix for loan references (LN-NNNN)'),

  -- ---- Account-number format ----
  ('account_number_prefix',  'ES',                                          'string',  'Prefix for member account numbers (ES-{G} NNNNNN)'),
  ('account_number_padding',  '6',                                          'integer', 'Number of digits in the account-number sequence'),

  -- ---- Audit / retention ----
  ('audit_log_retention',    '5000',                                         'integer', 'Maximum number of audit-log entries retained before FIFO purge'),

  -- ---- Loan term ----
  ('max_loan_term_months',   '60',                                          'integer', 'Maximum loan term allowed when submitting a request')
ON DUPLICATE KEY UPDATE
  `setting_value` = VALUES(`setting_value`),
  `data_type`     = VALUES(`data_type`),
  `description`   = VALUES(`description`);


-- ----------------------------------------------------------------------------
-- 5. LOAN CATEGORIES & PRICING
-- ----------------------------------------------------------------------------
-- The five loan products offered by Elite SACCO Mbarara, with their base
-- monthly interest rates (% per month, compounded on the outstanding
-- balance). These mirror the CATS object in the dashboard:
--
--     const CATS = {
--       'Normal Loan':           3,
--       'Special Loan':          2.5,
--       'Secured Business Loan': 2.5,
--       'Agricultural Loan':      2,
--       'School Fees Loan':       2
--     };
--
-- Two modifiers are also seeded:
--   * non_member_extra_rate  — extra % per month added for non-member
--                              borrowers (default 1%).
--   * term_adj_rates         — extra % per month added for longer terms
--                              (<=6 months: 0%; <=12 months: +0.25%;
--                              >12 months: +0.5%).
--
-- The effective monthly rate for a given loan is computed as:
--     rate = base_rate(cat) + term_adj(term) + non_member_extra(1 if non-member, else 0)
-- ----------------------------------------------------------------------------

INSERT INTO `settings` (`setting_key`, `setting_value`, `data_type`, `description`) VALUES
  -- ---- Loan products and base monthly rates ----
  ('loan_categories',
   '{"Normal Loan":3.00,"Special Loan":2.50,"Secured Business Loan":2.50,"Agricultural Loan":2.00,"School Fees Loan":2.00}',
   'json',
   'Map of loan product name -> base monthly interest rate (% per month, compounded on outstanding balance)'),

  -- ---- Non-member surcharge ----
  ('non_member_extra_rate', '1.00', 'decimal',
   'Extra % per month added to the base rate for non-member borrowers'),

  -- ---- Term-adjustment rates (graduated surcharge for longer terms) ----
  ('term_adj_rates',
   '{"lte_6":0.00,"lte_12":0.25,"gt_12":0.50}',
   'json',
   'Extra % per month added to the base rate based on the loan term: lte_6 = term <= 6 months, lte_12 = 7-12 months, gt_12 = > 12 months')
ON DUPLICATE KEY UPDATE
  `setting_value` = VALUES(`setting_value`),
  `data_type`     = VALUES(`data_type`),
  `description`   = VALUES(`description`);


-- ----------------------------------------------------------------------------
-- 6. REGULATOR & PRUDENTIAL BENCHMARKS
-- ----------------------------------------------------------------------------
-- Default regulator and the indicative prudential minimums / maximums used
-- when generating regulatory returns. These are STARTING POINTS — replace
-- them with the actual minimums in the regulator's current guidelines
-- before submitting any return.

INSERT INTO `settings` (`setting_key`, `setting_value`, `data_type`, `description`) VALUES
  -- ---- Regulator identity ----
  ('regulator_name',         'Uganda Microfinance Regulatory Authority (UMRA)', 'string',  'Prudential regulator to which returns are submitted'),
  ('registration_licence_no', '',                                              'string',  'SACCO registration / licence number with the regulator'),

  -- ---- Liquidity ----
  ('min_liquidity_ratio',     '15.00',  'decimal', 'Minimum liquidity ratio: liquid assets ÷ (savings + short-term liabilities) (%)'),

  -- ---- Capital adequacy ----
  ('min_core_capital_ratio',          '10.00', 'decimal', 'Minimum core capital ÷ total assets (%)'),
  ('min_institutional_capital_ratio','8.00',  'decimal', 'Minimum institutional capital ÷ total assets (%)'),

  -- ---- Portfolio quality ----
  ('max_par_30', '5.00', 'decimal', 'Maximum PAR 30 (portfolio at risk, 30+ days overdue) (%)'),
  ('max_par_90', '2.00', 'decimal', 'Maximum PAR 90 (portfolio at risk, 90+ days overdue) (%)')
ON DUPLICATE KEY UPDATE
  `setting_value` = VALUES(`setting_value`),
  `data_type`     = VALUES(`data_type`),
  `description`   = VALUES(`description`);


-- ----------------------------------------------------------------------------
-- 7. LOAN-LOSS PROVISION RATES (BY AGEING BUCKET)
-- ----------------------------------------------------------------------------
-- Five provision rates applied to principal outstanding, by overdue
-- bucket. Stored as a JSON array in the order:
--   [current, 1-29 days, 30-59 days, 60-89 days, 90+ days]
--
-- Defaults: 1% / 5% / 25% / 50% / 100%  (typical UMRA-style provisioning)
-- ----------------------------------------------------------------------------

INSERT INTO `settings` (`setting_key`, `setting_value`, `data_type`, `description`) VALUES
  ('provision_rates',
   '[1.00, 5.00, 25.00, 50.00, 100.00]',
   'json',
   'Loan-loss provision % by ageing bucket in the order: current / 1-29 days / 30-59 days / 60-89 days / 90+ days overdue')
ON DUPLICATE KEY UPDATE
  `setting_value` = VALUES(`setting_value`),
  `data_type`     = VALUES(`data_type`),
  `description`   = VALUES(`description`);


-- ============================================================================
-- 8. VERIFICATION (run after import to confirm the seed loaded correctly)
-- ============================================================================
-- SELECT 'roles' AS what, COUNT(*) AS n FROM roles
-- UNION ALL SELECT 'role_permissions',        COUNT(*) FROM role_permissions
-- UNION ALL SELECT 'users (admin only)',      COUNT(*) FROM users
-- UNION ALL SELECT 'settings (all)',          COUNT(*) FROM settings
-- UNION ALL SELECT 'settings (loan-related)', COUNT(*) FROM settings
--                                             WHERE setting_key IN
--                                              ('loan_categories',
--                                               'non_member_extra_rate',
--                                               'term_adj_rates',
--                                               'max_loan_term_months');
--
-- Expected counts:
--   roles               :  4
--   role_permissions    : 36   (9 perms × 4 roles)
--   users (admin only) :  1
--   settings (all)      : ~25
--   settings (loan-related) : 4
-- ============================================================================

-- ----------------------------------------------------------------------------
-- POST-IMPORT CHECKLIST
-- ----------------------------------------------------------------------------
--  [ ] Replace the placeholder password hash for admin@elitesacco.co.ug
--      with a real bcrypt hash (see section 3 above).
--  [ ] Set the SACCO's actual registration / licence number with UMRA
--      in the `registration_licence_no` setting.
--  [ ] Confirm the loan-category rates and provision rates match the
--      SACCO's current pricing policy and the regulator's current
--      minimums; adjust if needed.
--  [ ] Create real system-user accounts for the Treasurer, Credit
--      Supervisor and Credit Officer roles from the dashboard once the
--      admin has logged in.
--  [ ] If policies.sql has been imported, ensure the application calls
--      `CALL set_app_context(<user_id>);` after every login and
--      `CALL clear_app_context();` before returning the connection.
-- ----------------------------------------------------------------------------

-- End of seed.sql
