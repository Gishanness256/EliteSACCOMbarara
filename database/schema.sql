-- ============================================================================
-- ELITE SACCO MBARARA — DATABASE SCHEMA
-- Developed by Gisha-Tech Innovations
-- ----------------------------------------------------------------------------
-- Target RDBMS : MySQL 8.0+ (InnoDB engine)
-- Description   : Schema for the Elite SACCO Mbarara management system,
--                 covering users, role-based access control, members and
--                 non-member borrowers, savings transactions, loan requests,
--                 loans and repayments, audit logging, regulatory inputs
--                 and system settings.
-- ============================================================================

SET FOREIGN_KEY_CHECKS = 0;
SET NAMES utf8mb4;
SET sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION';

-- ----------------------------------------------------------------------------
-- TABLE: roles
-- System roles (Admin, Treasurer, Credit Supervisor, Credit Officer, etc.)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `roles` (
  `id`            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`          VARCHAR(50)  NOT NULL,
  `description`   VARCHAR(255) DEFAULT NULL,
  `is_system`     TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1 = built-in role, cannot be deleted',
  `created_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_roles_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- TABLE: role_permissions
-- Granular permissions granted to each role. A permission is a named
-- capability such as 'approve_loans', 'acknowledge_savings', etc.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `role_permissions` (
  `id`             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `role_id`        INT UNSIGNED NOT NULL,
  `permission_key` VARCHAR(80)  NOT NULL COMMENT 'e.g. approve_loans, set_interest_rates',
  `permission_desc` VARCHAR(255) DEFAULT NULL,
  `is_granted`     TINYINT(1)  NOT NULL DEFAULT 1 COMMENT '1 = granted, 0 = explicitly denied',
  `created_at`     DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_role_permission` (`role_id`, `permission_key`),
  KEY `idx_rp_permission` (`permission_key`),
  CONSTRAINT `fk_rp_role` FOREIGN KEY (`role_id`) REFERENCES `roles` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- TABLE: users
-- System users — staff who log in to the SACCO management dashboard
-- (Admin, Treasurer, Credit Supervisor, Credit Officer, etc.)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `users` (
  `id`             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `full_name`      VARCHAR(150) NOT NULL,
  `login_handle`   VARCHAR(64)  NOT NULL COMMENT 'local part of the email, e.g. jane',
  `email`          VARCHAR(150) NOT NULL COMMENT 'full handle@elitesacco.co.ug',
  `initials`       VARCHAR(6)   DEFAULT NULL COMMENT '2-4 letter initials used in ledgers',
  `role_id`        INT UNSIGNED NOT NULL,
  `password_hash`  VARCHAR(255) NOT NULL COMMENT 'bcrypt/argon2 hash; never store plaintext',
  `must_change_pw` TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '1 = force password change on next login',
  `is_active`      TINYINT(1)   NOT NULL DEFAULT 1,
  `last_login_at`  DATETIME     DEFAULT NULL,
  `last_login_ip`  VARCHAR(45)  DEFAULT NULL,
  `created_by`     INT UNSIGNED DEFAULT NULL COMMENT 'user id of the admin who created this account',
  `created_at`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_users_email` (`email`),
  UNIQUE KEY `uq_users_handle` (`login_handle`),
  KEY `idx_users_role` (`role_id`),
  CONSTRAINT `fk_users_role` FOREIGN KEY (`role_id`) REFERENCES `roles` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_users_creator` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- TABLE: members
-- SACCO members — account holders. Account number format: ES-{G} NNNNNN
-- (e.g. ES-F 000001 for a female member, ES-M 000002 for a male member).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `members` (
  `id`             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `account_number` VARCHAR(20)  NOT NULL COMMENT 'ES-{G} NNNNNN',
  `first_name`     VARCHAR(80)  NOT NULL,
  `last_name`      VARCHAR(80)  NOT NULL,
  `date_of_birth`  DATE         DEFAULT NULL,
  `gender`         CHAR(1)      DEFAULT NULL COMMENT 'F or M',
  `address`        VARCHAR(255) NOT NULL,
  `nin`            VARCHAR(20)  NOT NULL COMMENT 'National ID Number (Uganda)',
  `telephone`      VARCHAR(30)  NOT NULL,
  `email`          VARCHAR(150) DEFAULT NULL,
  `photo_path`     VARCHAR(255) DEFAULT NULL COMMENT 'path or URL to passport photo',
  `status`         ENUM('active','inactive','suspended','closed') NOT NULL DEFAULT 'active',
  `registered_by`  INT UNSIGNED DEFAULT NULL COMMENT 'user id of officer who registered the member',
  `registered_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_members_acc` (`account_number`),
  UNIQUE KEY `uq_members_nin` (`nin`),
  KEY `idx_members_name` (`last_name`, `first_name`),
  KEY `idx_members_phone` (`telephone`),
  CONSTRAINT `fk_members_registrar` FOREIGN KEY (`registered_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- TABLE: non_members
-- Borrowers who do not hold a SACCO member account (no account number).
-- Linked to loans via a surrogate id.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `non_members` (
  `id`            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `full_name`     VARCHAR(150) NOT NULL,
  `telephone`     VARCHAR(30)  DEFAULT NULL,
  `nin`           VARCHAR(20)  DEFAULT NULL,
  `address`       VARCHAR(255) DEFAULT NULL,
  `status`        ENUM('active','inactive') NOT NULL DEFAULT 'active',
  `created_by`    INT UNSIGNED DEFAULT NULL,
  `created_at`    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_nm_name` (`full_name`),
  KEY `idx_nm_phone` (`telephone`),
  CONSTRAINT `fk_nm_creator` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- TABLE: savings_transactions
-- Member deposits and withdrawals. Withdrawal flag (is_withdrawal) marks
-- outbound movements; otherwise the row is a deposit.
-- Ref format: SV-NNNNNN
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `savings_transactions` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `reference_no`   VARCHAR(20)  NOT NULL COMMENT 'SV-NNNNNN',
  `member_id`      INT UNSIGNED NOT NULL,
  `account_number` VARCHAR(20)  NOT NULL COMMENT 'denormalised for fast ledger queries',
  `amount`         DECIMAL(14,2) NOT NULL,
  `is_withdrawal`  TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1 = withdrawal, 0 = deposit',
  `transaction_date` DATETIME  NOT NULL,
  `channel`        ENUM('counter_cash','mobile_money','bank_transfer','salary_deduction','agent','other') NOT NULL DEFAULT 'counter_cash',
  `slip_no`        VARCHAR(50)  DEFAULT NULL COMMENT 'slip / receipt / reference number',
  `remarks`        VARCHAR(500) DEFAULT NULL,
  `recorded_by`    INT UNSIGNED DEFAULT NULL COMMENT 'user id of the officer',
  `officer_initials` VARCHAR(6) DEFAULT NULL COMMENT 'denormalised initials of officer',
  `created_at`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_savings_ref` (`reference_no`),
  KEY `idx_st_member` (`member_id`),
  KEY `idx_st_acc` (`account_number`),
  KEY `idx_st_date` (`transaction_date`),
  KEY `idx_st_channel` (`channel`),
  CONSTRAINT `fk_st_member` FOREIGN KEY (`member_id`) REFERENCES `members` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_st_officer` FOREIGN KEY (`recorded_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- TABLE: loan_requests
-- Loan applications submitted by members or non-members and awaiting
-- approval by the Admin. Ref format: LR-NNNN
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `loan_requests` (
  `id`              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `reference_no`    VARCHAR(20)  NOT NULL COMMENT 'LR-NNNN',
  `request_date`    DATE         NOT NULL,
  `applicant_type`  ENUM('member','non_member') NOT NULL,
  `member_id`       INT UNSIGNED DEFAULT NULL,
  `non_member_id`   INT UNSIGNED DEFAULT NULL,
  `applicant_name`  VARCHAR(150) NOT NULL COMMENT 'denormalised: first + last for members, full name for non-members',
  `telephone`       VARCHAR(30)  DEFAULT NULL,
  `email`           VARCHAR(150) DEFAULT NULL,
  `address`         VARCHAR(255) DEFAULT NULL,
  `loan_category`   VARCHAR(80)  NOT NULL COMMENT 'Normal Loan, Special Loan, Secured Business Loan, Agricultural Loan, School Fees Loan',
  `term_months`     TINYINT UNSIGNED NOT NULL,
  `principal_amount` DECIMAL(14,2) NOT NULL,
  `interest_rate`   DECIMAL(5,2) NOT NULL COMMENT '% per month, compounded monthly on outstanding balance',
  `status`          ENUM('pending','approved','on_hold','rejected') NOT NULL DEFAULT 'pending',
  `requested_by`    INT UNSIGNED DEFAULT NULL COMMENT 'user id of the officer who logged the request',
  `requested_by_initials` VARCHAR(6) DEFAULT NULL,
  `decided_by`      INT UNSIGNED DEFAULT NULL,
  `decision_date`   DATE         DEFAULT NULL,
  `remark`          VARCHAR(500) DEFAULT NULL COMMENT 'required when rejecting / holding',
  `created_at`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_loan_req_ref` (`reference_no`),
  KEY `idx_lr_status` (`status`),
  KEY `idx_lr_member` (`member_id`),
  KEY `idx_lr_nonmember` (`non_member_id`),
  KEY `idx_lr_date` (`request_date`),
  CONSTRAINT `fk_lr_member` FOREIGN KEY (`member_id`) REFERENCES `members` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_lr_nonmember` FOREIGN KEY (`non_member_id`) REFERENCES `non_members` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_lr_requested_by` FOREIGN KEY (`requested_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_lr_decided_by` FOREIGN KEY (`decided_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `chk_lr_applicant` CHECK (
    (`applicant_type` = 'member'     AND `member_id`     IS NOT NULL) OR
    (`applicant_type` = 'non_member' AND `non_member_id` IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- TABLE: loans
-- Approved and disbursed loans. Ref format: LN-NNNN.
-- Repayments are stored in loan_repayments. The outstanding balance is
-- derived (principal + accrued monthly interest − total paid).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `loans` (
  `id`              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `reference_no`    VARCHAR(20)  NOT NULL COMMENT 'LN-NNNN',
  `loan_request_id` INT UNSIGNED DEFAULT NULL,
  `member_id`       INT UNSIGNED DEFAULT NULL,
  `non_member_id`   INT UNSIGNED DEFAULT NULL,
  `account_number`  VARCHAR(20) DEFAULT NULL COMMENT 'denormalised for members',
  `borrower_name`   VARCHAR(150) NOT NULL COMMENT 'denormalised borrower name',
  `telephone`       VARCHAR(30)  DEFAULT NULL,
  `loan_category`   VARCHAR(80)  NOT NULL,
  `term_months`     TINYINT UNSIGNED DEFAULT NULL,
  `principal_amount` DECIMAL(14,2) NOT NULL,
  `interest_rate`   DECIMAL(5,2) NOT NULL COMMENT '% per month, compounded on outstanding balance',
  `disbursement_date` DATE NOT NULL,
  `due_date`        DATE         DEFAULT NULL COMMENT 'disbursement_date + term_months',
  `status`          ENUM('active','cleared','overdue','written_off') NOT NULL DEFAULT 'active',
  `disbursed_by`    INT UNSIGNED DEFAULT NULL,
  `disbursed_initials` VARCHAR(6) DEFAULT NULL,
  `is_imported`     TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1 = imported from legacy records',
  `created_at`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_loans_ref` (`reference_no`),
  KEY `idx_loans_member` (`member_id`),
  KEY `idx_loans_nonmember` (`non_member_id`),
  KEY `idx_loans_status` (`status`),
  KEY `idx_loans_disb_date` (`disbursement_date`),
  KEY `idx_loans_due_date` (`due_date`),
  CONSTRAINT `fk_loans_request` FOREIGN KEY (`loan_request_id`) REFERENCES `loan_requests` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_loans_member` FOREIGN KEY (`member_id`) REFERENCES `members` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_loans_nonmember` FOREIGN KEY (`non_member_id`) REFERENCES `non_members` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_loans_officer` FOREIGN KEY (`disbursed_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `chk_loans_borrower` CHECK (
    `member_id` IS NOT NULL OR `non_member_id` IS NOT NULL
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- TABLE: loan_repayments
-- Individual repayments against a loan (installment, lump sum, full
-- settlement, or imported payments).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `loan_repayments` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `loan_id`          INT UNSIGNED NOT NULL,
  `payment_date`     DATE NOT NULL,
  `amount`           DECIMAL(14,2) NOT NULL,
  `principal_paid`   DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT 'derived portion applied to principal',
  `interest_paid`    DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT 'derived portion applied to interest',
  `payment_type`     ENUM('installment','lump_sum','full_settlement','imported','other') NOT NULL DEFAULT 'installment',
  `balance_after`    DECIMAL(14,2) DEFAULT NULL COMMENT 'outstanding balance after this payment',
  `recorded_by`      INT UNSIGNED DEFAULT NULL,
  `officer_initials` VARCHAR(6)  DEFAULT NULL,
  `remarks`          VARCHAR(500) DEFAULT NULL,
  `created_at`       DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_lr_loan` (`loan_id`),
  KEY `idx_lr_date` (`payment_date`),
  CONSTRAINT `fk_repayments_loan` FOREIGN KEY (`loan_id`) REFERENCES `loans` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_repayments_officer` FOREIGN KEY (`recorded_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- TABLE: audit_log
-- Append-only record of actions performed by system users. Entries cannot
-- be edited or deleted from the UI (only retained for compliance).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `audit_log` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `event_time`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `user_id`         INT UNSIGNED DEFAULT NULL,
  `user_name`       VARCHAR(150) DEFAULT NULL COMMENT 'denormalised snapshot',
  `user_email`      VARCHAR(150) DEFAULT NULL COMMENT 'denormalised snapshot',
  `role_name`       VARCHAR(50)  DEFAULT NULL COMMENT 'denormalised snapshot',
  `officer_initials` VARCHAR(6)  DEFAULT NULL,
  `action`          VARCHAR(80)  NOT NULL COMMENT 'e.g. Login, User created, Loan approved',
  `particulars`     VARCHAR(500) DEFAULT NULL COMMENT 'free-text detail of what was done',
  `ip_address`      VARCHAR(45)  DEFAULT NULL,
  `user_agent`      VARCHAR(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_audit_time` (`event_time`),
  KEY `idx_audit_user` (`user_id`),
  KEY `idx_audit_action` (`action`),
  CONSTRAINT `fk_audit_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- TABLE: regulatory_inputs
-- Monthly financial inputs that the system does NOT track elsewhere —
-- cash on hand, bank balances, other liquid investments, other assets,
-- other liabilities, member share capital, statutory reserves,
-- fee income, savings interest paid, operating expenses.
-- Balance items carry forward to later months until changed; income and
-- expense items apply to that month only.
-- Key format: YYYY-MM
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `regulatory_inputs` (
  `id`                       INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `period_key`               CHAR(7)     NOT NULL COMMENT 'YYYY-MM',
  `item_key`                 VARCHAR(40) NOT NULL COMMENT 'cash, bank, liq, oa, ol, sh, rs, fee, sint, opx',
  `item_label`               VARCHAR(120) DEFAULT NULL COMMENT 'human-readable description',
  `item_type`                ENUM('balance','flow') NOT NULL COMMENT 'balance = carried forward; flow = month only',
  `amount`                   DECIMAL(14,2) NOT NULL DEFAULT 0,
  `entered_by`               INT UNSIGNED DEFAULT NULL,
  `created_at`               DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`               DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_regin_period_item` (`period_key`, `item_key`),
  KEY `idx_regin_period` (`period_key`),
  KEY `idx_regin_item` (`item_key`),
  CONSTRAINT `fk_regin_user` FOREIGN KEY (`entered_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- TABLE: settings
-- Single-row (or key-value) table for institution-level configuration:
-- regulator details, prudential benchmarks, loan-loss provision rates,
-- loan product pricing, and other system-wide defaults.
-- Implemented here as a key/value table so it can grow without migration.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `settings` (
  `id`            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `setting_key`   VARCHAR(80)  NOT NULL,
  `setting_value` TEXT         NOT NULL,
  `data_type`     ENUM('string','integer','decimal','boolean','json') NOT NULL DEFAULT 'string',
  `description`   VARCHAR(255) DEFAULT NULL,
  `updated_by`    INT UNSIGNED DEFAULT NULL,
  `created_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_settings_key` (`setting_key`),
  CONSTRAINT `fk_settings_user` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;

-- ============================================================================
-- SEED DATA
-- ============================================================================

-- ---- Default roles ---------------------------------------------------------
INSERT INTO `roles` (`name`, `description`, `is_system`) VALUES
  ('Admin',              'Full system administrator; manages users, settings and all modules.', 1),
  ('Treasurer',          'Manages savings, portfolio and regulatory returns.', 1),
  ('Credit Supervisor',  'Supervises loan approvals and credit operations.', 1),
  ('Credit Officer',     'Receives loan requests and acknowledges savings.', 1);

-- ---- Default role permissions ---------------------------------------------
-- permission_key values mirror the 9 capabilities shown in the Access Levels UI
INSERT INTO `role_permissions` (`role_id`, `permission_key`, `permission_desc`, `is_granted`) VALUES
  -- Admin: all permissions granted
  (1, 'approve_loans',              'Approve loans',                              1),
  (1, 'acknowledge_savings',        'Acknowledge savings / deposits',            1),
  (1, 'acknowledge_loan_repayments','Acknowledge loan repayments',                1),
  (1, 'set_interest_rates',         'Set interest rates',                         1),
  (1, 'manage_system_users',        'Create / remove system users',                1),
  (1, 'manage_member_accounts',     'Create / remove member accounts',             1),
  (1, 'view_weekly_reports',        'Generate weekly reports',                    1),
  (1, 'view_monthly_reports',       'Generate monthly reports',                   1),
  (1, 'view_annual_reports',        'Generate annual reports',                    1),
  -- Treasurer: savings, repayments, reports
  (2, 'approve_loans',              'Approve loans',                              0),
  (2, 'acknowledge_savings',        'Acknowledge savings / deposits',             1),
  (2, 'acknowledge_loan_repayments','Acknowledge loan repayments',                 1),
  (2, 'set_interest_rates',         'Set interest rates',                         0),
  (2, 'manage_system_users',        'Create / remove system users',                0),
  (2, 'manage_member_accounts',     'Create / remove member accounts',             0),
  (2, 'view_weekly_reports',        'Generate weekly reports',                    1),
  (2, 'view_monthly_reports',       'Generate monthly reports',                   1),
  (2, 'view_annual_reports',        'Generate annual reports',                    1),
  -- Credit Supervisor: approvals, repayments, rates, weekly/monthly reports
  (3, 'approve_loans',              'Approve loans',                              1),
  (3, 'acknowledge_savings',        'Acknowledge savings / deposits',             0),
  (3, 'acknowledge_loan_repayments','Acknowledge loan repayments',                 1),
  (3, 'set_interest_rates',         'Set interest rates',                         1),
  (3, 'manage_system_users',        'Create / remove system users',                0),
  (3, 'manage_member_accounts',     'Create / remove member accounts',             0),
  (3, 'view_weekly_reports',        'Generate weekly reports',                    1),
  (3, 'view_monthly_reports',       'Generate monthly reports',                   1),
  (3, 'view_annual_reports',        'Generate annual reports',                    0),
  -- Credit Officer: savings + repayments only
  (4, 'approve_loans',              'Approve loans',                              0),
  (4, 'acknowledge_savings',        'Acknowledge savings / deposits',             1),
  (4, 'acknowledge_loan_repayments','Acknowledge loan repayments',                 1),
  (4, 'set_interest_rates',         'Set interest rates',                         0),
  (4, 'manage_system_users',        'Create / remove system users',                0),
  (4, 'manage_member_accounts',     'Create / remove member accounts',             0),
  (4, 'view_weekly_reports',        'Generate weekly reports',                    0),
  (4, 'view_monthly_reports',       'Generate monthly reports',                   0),
  (4, 'view_annual_reports',        'Generate annual reports',                    0);

-- ---- Default system settings ----------------------------------------------
INSERT INTO `settings` (`setting_key`, `setting_value`, `data_type`, `description`) VALUES
  ('institution_name',        'Elite SACCO Mbarara',                                 'string',  'SACCO display name'),
  ('institution_tagline',     'ELITE SACCO MBARARA, GUARANTEED SUCCESS',            'string',  'SACCO tagline'),
  ('developer',               'Gisha-Tech Innovations',                            'string',  'System developer'),
  ('login_domain',            'elitesacco.co.ug',                                  'string',  'Email domain appended to login handles'),
  ('default_password_length', '6',                                                  'integer','Minimum password length'),
  ('savings_ref_prefix',     'SV',                                                 'string',  'Savings transaction reference prefix'),
  ('loan_request_ref_prefix','LR',                                                  'string',  'Loan request reference prefix'),
  ('loan_ref_prefix',        'LN',                                                  'string',  'Loan reference prefix'),
  ('regulator_name',         'Uganda Microfinance Regulatory Authority (UMRA)',     'string',  'Prudential regulator'),
  ('registration_licence_no','',                                                     'string',  'SACCO registration / licence number'),
  ('min_liquidity_ratio',    '15',                                                  'decimal','Minimum liquidity ratio (%)'),
  ('min_core_capital_ratio', '10',                                                  'decimal','Minimum core capital ÷ total assets (%)'),
  ('min_institutional_capital_ratio','8',                                           'decimal','Minimum institutional capital ÷ total assets (%)'),
  ('max_par_30',              '5',                                                  'decimal','Maximum PAR 30 (%)'),
  ('max_par_90',              '2',                                                  'decimal','Maximum PAR 90 (%)'),
  ('provision_rates',        '[1,5,25,50,100]',                                    'json',   'Loan-loss provision % by ageing bucket: current / 1-29 / 30-59 / 60-89 / 90+ days'),
  ('loan_categories',        '{"Normal Loan":3,"Special Loan":2.5,"Secured Business Loan":2.5,"Agricultural Loan":2,"School Fees Loan":2}', 'json', 'Loan product → base monthly interest rate (%)'),
  ('non_member_extra_rate',  '1',                                                  'decimal','Extra % per month charged to non-members'),
  ('term_adj_rates',         '{"<=6":0,"<=12":0.25,">12":0.5}',                   'json',   'Extra % per month added for longer terms'),
  ('max_loan_term_months',  '60',                                                  'integer','Maximum loan term allowed'),
  ('audit_log_retention',   '5000',                                                'integer','Maximum audit log entries retained before FIFO purge');

-- ---- Seed a default System Admin account -----------------------------------
-- NOTE: this is a placeholder hash. Replace with a real bcrypt/argon2 hash
-- in production and force must_change_pw = 1 on first login.
INSERT INTO `users` (`full_name`, `login_handle`, `email`, `initials`, `role_id`, `password_hash`, `must_change_pw`, `is_active`)
VALUES ('System Admin', 'admin', 'admin@elitesacco.co.ug', 'SA', 1, '$2y$10$REPLACE_WITH_REAL_BCRYPT_HASH', 1, 1);

-- ============================================================================
-- END OF SCHEMA
-- ============================================================================
