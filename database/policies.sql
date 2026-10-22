-- ============================================================================
-- ELITE SACCO MBARARA — ROW-LEVEL SECURITY POLICIES
-- File: policies.sql
-- Developed by Gisha-Tech Innovations
-- ============================================================================
-- Target RDBMS : MySQL 8.0+ (InnoDB)
-- Depends on  : schema.sql (must be imported first)
--
-- DESIGN NOTE
-- -----------
-- MySQL does NOT have a native `CREATE POLICY` statement like PostgreSQL.
-- Row-Level Security is therefore implemented using the standard MySQL
-- RLS pattern with three layers:
--
--   1. SESSION CONTEXT
--      After the application authenticates a user, it calls
--      `CALL set_app_context(<user_id>);` once per DB connection. This
--      caches the user id, role id and role name in session variables
--      (@app_user_id, @app_role_id, @app_role_name) so that subsequent
--      queries and triggers operate under that identity.
--
--   2. READ-VIEWS  (one `_v` view per table)
--      Direct SELECT on base tables is revoked. The application reads
--      through `_v` views that filter rows by the current role:
--        - High-sensitivity tables (users, role_permissions, audit_log,
--          regulatory_inputs, settings) expose rows only to authorised
--          roles; everyone else sees nothing (or just their own row).
--        - Financial tables (savings_transactions, loan_requests,
--          loans, loan_repayments, members, non_members) are visible
--          to every authenticated session — the row-level controls
--          there are on writes, not reads.
--
--   3. WRITE TRIGGERS  (BEFORE INSERT / UPDATE / DELETE on every table)
--      Each trigger inspects the current session's role and the row
--      being changed, and raises `SIGNAL SQLSTATE '45000'` when the
--      operation is not authorised. This includes:
--        - Module-level gating (e.g. only Admin may write to `users`).
--        - Permission checks via app_has_permission('...').
--        - Row-level ownership (e.g. officers can only modify the
--          savings transactions / loan repayments THEY recorded).
--
-- TRUST BOUNDARY
-- --------------
-- The application server is trusted to:
--   (a) authenticate end-users against the `users` table,
--   (b) call `set_app_context(user_id)` immediately after authentication
--       and `clear_app_context()` before returning the connection to
--       the pool.
-- The DB enforces everything else.
-- ============================================================================

CREATE DATABASE IF NOT EXISTS `elite_sacco`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;
USE `elite_sacco`;

SET NAMES utf8mb4;
SET sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION';

-- ============================================================================
-- ACCESS MATRIX (summary — see individual triggers for the precise rule)
-- ============================================================================
--                              |  Admin  | Treasurer | Credit Sup. | Credit Off. |
-- ---------------------------- | ------ | --------- | ----------- | ----------- |
-- users              R         |  all   |   own    |    own     |    own     |
-- users              W (CRUD)  |  yes   |    no    |     no     |     no     |
-- roles              R         |  all   |   all*   |    all*    |    all*    |
-- roles              W         |  yes   |    no    |     no     |     no     |
-- role_permissions   R         |  all   |   own*   |    own*    |    own*    |
-- role_permissions   W         |  yes   |    no    |     no     |     no     |
-- members            R         |  all   |   all    |    all     |    all     |
-- members            C/U       |  yes** |   yes**  |    yes**   |    yes**   |
-- members            D         |  yes   |    no    |     no     |     no     |
-- non_members        R         |  all   |   all    |    all     |    all     |
-- non_members        C/U       |  yes   |   yes    |    yes     |    yes     |
-- non_members        D         |  yes   |    no    |     no     |     no     |
-- savings_txn        R         |  all   |   all    |    all     |    all     |
-- savings_txn        C         |  yes## |   yes##  |     no     |    yes##   |
-- savings_txn        U/D       |  yes   |   own##  |     no     |    own##   |
-- loan_requests      R         |  all   |   all    |    all     |    all     |
-- loan_requests      C         |  yes   |   yes    |    yes     |    yes     |
-- loan_requests      U         |  yes   |    no    |     no     |   own&&    |
-- loan_requests      D         |  yes   |    no    |     no     |     no     |
-- loans              R         |  all   |   all    |    all     |    all     |
-- loans              C         |  yes   |    no    |     no     |     no     |
-- loans              U/D       |  yes   |    no    |     no     |     no     |
-- loan_repayments    R         |  all   |   all    |    all     |    all     |
-- loan_repayments    C         |  yes## |   yes##  |    yes##   |    yes##   |
-- loan_repayments    U/D       |  yes   |   own##  |    own##   |    own##   |
-- audit_log          R         |  all   |   all    |     no     |     no     |
-- audit_log          C         |  yes   |   yes    |    yes     |    yes     |
-- audit_log          U         |  no (immutable for everyone)                    |
-- audit_log          D         |  yes   |    no    |     no     |     no     |
-- regulatory_inputs  R         |  all   |   all    |    all     |     no     |
-- regulatory_inputs  W         |  yes   |   yes    |     no     |     no     |
-- settings           R         |  all   |   all    |    all     |     no     |
-- settings           W         |  yes   |   yes    |     no     |     no     |
--
-- Legend:
--   own  = only rows where the current user is the creator/owner
--   *    = read-only at this privilege level
--   **   = requires the manage_member_accounts permission
--   ##   = requires the acknowledge_savings / acknowledge_loan_repayments perm
--   &&   = only while the request is still 'pending'
-- ============================================================================


-- ============================================================================
-- 1. SESSION CONTEXT
-- ============================================================================

-- ---------------------------------------------------------------------------
-- set_app_context(p_user_id)
-- Called by the application immediately after authenticating a user.
-- Validates the user exists and is active, then caches identity in
-- session variables for the lifetime of this connection.
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS set_app_context;
DELIMITER //
CREATE PROCEDURE set_app_context(IN p_user_id INT UNSIGNED)
  SQL SECURITY DEFINER
  MODIFIES SQL DATA
BEGIN
  DECLARE v_role_id   INT UNSIGNED;
  DECLARE v_role_name VARCHAR(50);

  IF p_user_id IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: cannot set app context — user id is NULL';
  END IF;

  SELECT u.role_id, r.name
    INTO v_role_id, v_role_name
    FROM `users` u
    JOIN `roles`   r ON r.id = u.role_id
   WHERE u.id = p_user_id
     AND u.is_active = 1;

  IF v_role_id IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: cannot set app context — user not found or inactive';
  END IF;

  SET @app_user_id   := p_user_id;
  SET @app_role_id   := v_role_id;
  SET @app_role_name := v_role_name;
END //
DELIMITER ;

-- ---------------------------------------------------------------------------
-- clear_app_context()
-- Called before returning a pooled connection. Resets the session so no
-- identity leaks across requests.
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS clear_app_context;
DELIMITER //
CREATE PROCEDURE clear_app_context()
  SQL SECURITY DEFINER
  CONTAINS SQL
BEGIN
  SET @app_user_id   := NULL;
  SET @app_role_id   := NULL;
  SET @app_role_name := NULL;
END //
DELIMITER ;


-- ============================================================================
-- 2. HELPER FUNCTIONS (read session context / check permissions)
-- ============================================================================

-- app_user_id() — current session user id, or NULL if not set
DROP FUNCTION IF EXISTS app_user_id;
DELIMITER //
CREATE FUNCTION app_user_id()
  RETURNS INT UNSIGNED
  NOT DETERMINISTIC
  NO SQL
BEGIN
  RETURN @app_user_id;
END //
DELIMITER ;

-- app_role_id() — current session role id, or NULL
DROP FUNCTION IF EXISTS app_role_id;
DELIMITER //
CREATE FUNCTION app_role_id()
  RETURNS INT UNSIGNED
  NOT DETERMINISTIC
  NO SQL
BEGIN
  RETURN @app_role_id;
END //
DELIMITER ;

-- app_role_name() — current session role name, or NULL
DROP FUNCTION IF EXISTS app_role_name;
DELIMITER //
CREATE FUNCTION app_role_name()
  RETURNS VARCHAR(50)
  NOT DETERMINISTIC
  NO SQL
BEGIN
  RETURN @app_role_name;
END //
DELIMITER ;

-- app_has_permission(p_perm_key)
-- Returns 1 if the current session's role has the named permission granted,
-- 0 otherwise (including when no session is set).
DROP FUNCTION IF EXISTS app_has_permission;
DELIMITER //
CREATE FUNCTION app_has_permission(p_perm_key VARCHAR(80))
  RETURNS TINYINT(1)
  NOT DETERMINISTIC
  READS SQL DATA
BEGIN
  DECLARE v_granted INT DEFAULT 0;

  IF @app_role_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT COUNT(*) INTO v_granted
    FROM `role_permissions`
   WHERE role_id = @app_role_id
     AND permission_key = p_perm_key
     AND is_granted = 1;

  RETURN IF(v_granted > 0, 1, 0);
END //
DELIMITER ;

-- app_is_admin() — convenience: 1 if the current session is the Admin role
DROP FUNCTION IF EXISTS app_is_admin;
DELIMITER //
CREATE FUNCTION app_is_admin()
  RETURNS TINYINT(1)
  NOT DETERMINISTIC
  NO SQL
BEGIN
  RETURN IF(@app_role_name = 'Admin', 1, 0);
END //
DELIMITER ;


-- ============================================================================
-- 3. READ-FILTERING VIEWS
-- ============================================================================
-- One view per base table. The application is granted SELECT on these views
-- (and revoked SELECT on the underlying base tables).
--
-- Visibility rules:
--   * Financial tables (members, non_members, savings_transactions,
--     loan_requests, loans, loan_repayments) — visible to ANY authenticated
--     session. Row-level controls are enforced on writes only.
--   * Sensitive tables (users, role_permissions, audit_log,
--     regulatory_inputs, settings) — visible only to authorised roles;
--     everyone else sees nothing (or, for users, only their own row).
-- ---------------------------------------------------------------------------

-- users_v — Admin sees all rows; every other role sees only their own row.
DROP VIEW IF EXISTS `users_v`;
CREATE VIEW `users_v` AS
  SELECT id, full_name, login_handle, email, initials, role_id,
         must_change_pw, is_active, last_login_at, last_login_ip,
         created_by, created_at, updated_at
    FROM `users`
   WHERE @app_user_id IS NOT NULL
     AND ( @app_role_name = 'Admin' OR id = @app_user_id );

-- roles_v — reference data; visible to every authenticated session (read-only).
DROP VIEW IF EXISTS `roles_v`;
CREATE VIEW `roles_v` AS
  SELECT id, name, description, is_system, created_at, updated_at
    FROM `roles`
   WHERE @app_user_id IS NOT NULL;

-- role_permissions_v — Admin sees all rows; other roles see only their own
-- role's permissions (so an officer can know what they are allowed to do,
-- but not what other roles can do).
DROP VIEW IF EXISTS `role_permissions_v`;
CREATE VIEW `role_permissions_v` AS
  SELECT rp.id, rp.role_id, r.name AS role_name,
         rp.permission_key, rp.permission_desc, rp.is_granted,
         rp.created_at, rp.updated_at
    FROM `role_permissions` rp
    JOIN `roles` r ON r.id = rp.role_id
   WHERE @app_user_id IS NOT NULL
     AND ( @app_role_name = 'Admin' OR rp.role_id = @app_role_id );

-- members_v — visible to every authenticated session.
DROP VIEW IF EXISTS `members_v`;
CREATE VIEW `members_v` AS
  SELECT id, account_number, first_name, last_name, date_of_birth, gender,
         address, nin, telephone, email, photo_path, status,
         registered_by, registered_at, updated_at
    FROM `members`
   WHERE @app_user_id IS NOT NULL;

-- non_members_v — visible to every authenticated session.
DROP VIEW IF EXISTS `non_members_v`;
CREATE VIEW `non_members_v` AS
  SELECT id, full_name, telephone, nin, address, status,
         created_by, created_at, updated_at
    FROM `non_members`
   WHERE @app_user_id IS NOT NULL;

-- savings_transactions_v — visible to every authenticated session.
DROP VIEW IF EXISTS `savings_transactions_v`;
CREATE VIEW `savings_transactions_v` AS
  SELECT id, reference_no, member_id, account_number, amount, is_withdrawal,
         transaction_date, channel, slip_no, remarks, recorded_by,
         officer_initials, created_at
    FROM `savings_transactions`
   WHERE @app_user_id IS NOT NULL;

-- loan_requests_v — visible to every authenticated session.
DROP VIEW IF EXISTS `loan_requests_v`;
CREATE VIEW `loan_requests_v` AS
  SELECT id, reference_no, request_date, applicant_type, member_id, non_member_id,
         applicant_name, telephone, email, address, loan_category, term_months,
         principal_amount, interest_rate, status, requested_by,
         requested_by_initials, decided_by, decision_date, remark,
         created_at, updated_at
    FROM `loan_requests`
   WHERE @app_user_id IS NOT NULL;

-- loans_v — visible to every authenticated session.
DROP VIEW IF EXISTS `loans_v`;
CREATE VIEW `loans_v` AS
  SELECT id, reference_no, loan_request_id, member_id, non_member_id,
         account_number, borrower_name, telephone, loan_category, term_months,
         principal_amount, interest_rate, disbursement_date, due_date, status,
         disbursed_by, disbursed_initials, is_imported, created_at, updated_at
    FROM `loans`
   WHERE @app_user_id IS NOT NULL;

-- loan_repayments_v — visible to every authenticated session.
DROP VIEW IF EXISTS `loan_repayments_v`;
CREATE VIEW `loan_repayments_v` AS
  SELECT id, loan_id, payment_date, amount, principal_paid, interest_paid,
         payment_type, balance_after, recorded_by, officer_initials,
         remarks, created_at
    FROM `loan_repayments`
   WHERE @app_user_id IS NOT NULL;

-- audit_log_v — only Admin and Treasurer may read.
DROP VIEW IF EXISTS `audit_log_v`;
CREATE VIEW `audit_log_v` AS
  SELECT id, event_time, user_id, user_name, user_email, role_name,
         officer_initials, action, particulars, ip_address, user_agent
    FROM `audit_log`
   WHERE @app_user_id IS NOT NULL
     AND @app_role_name IN ('Admin', 'Treasurer');

-- regulatory_inputs_v — Admin, Treasurer, Credit Supervisor may read.
DROP VIEW IF EXISTS `regulatory_inputs_v`;
CREATE VIEW `regulatory_inputs_v` AS
  SELECT id, period_key, item_key, item_label, item_type, amount,
         entered_by, created_at, updated_at
    FROM `regulatory_inputs`
   WHERE @app_user_id IS NOT NULL
     AND @app_role_name IN ('Admin', 'Treasurer', 'Credit Supervisor');

-- settings_v — Admin, Treasurer, Credit Supervisor may read.
DROP VIEW IF EXISTS `settings_v`;
CREATE VIEW `settings_v` AS
  SELECT id, setting_key, setting_value, data_type, description,
         updated_by, created_at, updated_at
    FROM `settings`
   WHERE @app_user_id IS NOT NULL
     AND @app_role_name IN ('Admin', 'Treasurer', 'Credit Supervisor');


-- ============================================================================
-- 4. WRITE-ENFORCING TRIGGERS
-- ============================================================================
-- Every base table has BEFORE INSERT / UPDATE / DELETE triggers that raise
-- SQLSTATE '45000' (unhandled user-defined exception) when the current
-- session is not authorised for the operation.
--
-- The MySQL error code returned to the client is 1644 (ER_SIGNAL_EXCEPTION).
-- Applications should map this to a 403 Forbidden response.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- 4.1  users
-- ===========================================================================
-- Only Admin may create / modify / remove system user accounts.

DROP TRIGGER IF EXISTS trg_users_bi;
DELIMITER //
CREATE TRIGGER trg_users_bi BEFORE INSERT ON `users`
FOR EACH ROW
BEGIN
  IF @app_role_name <> 'Admin' OR @app_role_name IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: only Admin may create system users';
  END IF;
END //

DROP TRIGGER IF EXISTS trg_users_bu;
CREATE TRIGGER trg_users_bu BEFORE UPDATE ON `users`
FOR EACH ROW
BEGIN
  IF @app_role_name <> 'Admin' OR @app_role_name IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: only Admin may modify system users';
  END IF;
END //

DROP TRIGGER IF EXISTS trg_users_bd;
CREATE TRIGGER trg_users_bd BEFORE DELETE ON `users`
FOR EACH ROW
BEGIN
  IF @app_role_name <> 'Admin' OR @app_role_name IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: only Admin may remove system users';
  END IF;
END //
DELIMITER ;


-- ===========================================================================
-- 4.2  roles
-- ===========================================================================
-- Roles are reference data; only Admin may change them.

DROP TRIGGER IF EXISTS trg_roles_bi;
DELIMITER //
CREATE TRIGGER trg_roles_bi BEFORE INSERT ON `roles`
FOR EACH ROW
BEGIN
  IF @app_role_name <> 'Admin' OR @app_role_name IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: only Admin may create roles';
  END IF;
END //

DROP TRIGGER IF EXISTS trg_roles_bu;
CREATE TRIGGER trg_roles_bu BEFORE UPDATE ON `roles`
FOR EACH ROW
BEGIN
  IF @app_role_name <> 'Admin' OR @app_role_name IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: only Admin may modify roles';
  END IF;
END //

DROP TRIGGER IF EXISTS trg_roles_bd;
CREATE TRIGGER trg_roles_bd BEFORE DELETE ON `roles`
FOR EACH ROW
BEGIN
  IF @app_role_name <> 'Admin' OR @app_role_name IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: only Admin may delete roles';
  END IF;
END //
DELIMITER ;


-- ===========================================================================
-- 4.3  role_permissions
-- ===========================================================================
-- Only Admin may grant or revoke permissions.

DROP TRIGGER IF EXISTS trg_role_permissions_bi;
DELIMITER //
CREATE TRIGGER trg_role_permissions_bi BEFORE INSERT ON `role_permissions`
FOR EACH ROW
BEGIN
  IF @app_role_name <> 'Admin' OR @app_role_name IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: only Admin may grant permissions';
  END IF;
END //

DROP TRIGGER IF EXISTS trg_role_permissions_bu;
CREATE TRIGGER trg_role_permissions_bu BEFORE UPDATE ON `role_permissions`
FOR EACH ROW
BEGIN
  IF @app_role_name <> 'Admin' OR @app_role_name IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: only Admin may modify permissions';
  END IF;
END //

DROP TRIGGER IF EXISTS trg_role_permissions_bd;
CREATE TRIGGER trg_role_permissions_bd BEFORE DELETE ON `role_permissions`
FOR EACH ROW
BEGIN
  IF @app_role_name <> 'Admin' OR @app_role_name IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: only Admin may revoke permissions';
  END IF;
END //
DELIMITER ;


-- ===========================================================================
-- 4.4  members
-- ===========================================================================
-- INSERT / UPDATE: requires manage_member_accounts permission.
-- DELETE: Admin only (protects referential integrity of savings & loans).

DROP TRIGGER IF EXISTS trg_members_bi;
DELIMITER //
CREATE TRIGGER trg_members_bi BEFORE INSERT ON `members`
FOR EACH ROW
BEGIN
  IF app_has_permission('manage_member_accounts') = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: you do not have permission to register members';
  END IF;
END //

DROP TRIGGER IF EXISTS trg_members_bu;
CREATE TRIGGER trg_members_bu BEFORE UPDATE ON `members`
FOR EACH ROW
BEGIN
  IF app_has_permission('manage_member_accounts') = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: you do not have permission to edit members';
  END IF;
END //

DROP TRIGGER IF EXISTS trg_members_bd;
CREATE TRIGGER trg_members_bd BEFORE DELETE ON `members`
FOR EACH ROW
BEGIN
  IF @app_role_name <> 'Admin' OR @app_role_name IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: only Admin may delete member accounts';
  END IF;
END //
DELIMITER ;


-- ===========================================================================
-- 4.5  non_members
-- ===========================================================================
-- INSERT / UPDATE: any authenticated session (officers add non-member
-- borrowers when registering loan requests).
-- DELETE: Admin only.

DROP TRIGGER IF EXISTS trg_non_members_bi;
DELIMITER //
CREATE TRIGGER trg_non_members_bi BEFORE INSERT ON `non_members`
FOR EACH ROW
BEGIN
  IF @app_user_id IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: no app context — cannot create non-member';
  END IF;
END //

DROP TRIGGER IF EXISTS trg_non_members_bu;
CREATE TRIGGER trg_non_members_bu BEFORE UPDATE ON `non_members`
FOR EACH ROW
BEGIN
  IF @app_user_id IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: no app context — cannot update non-member';
  END IF;
END //

DROP TRIGGER IF EXISTS trg_non_members_bd;
CREATE TRIGGER trg_non_members_bd BEFORE DELETE ON `non_members`
FOR EACH ROW
BEGIN
  IF @app_role_name <> 'Admin' OR @app_role_name IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: only Admin may delete non-members';
  END IF;
END //
DELIMITER ;


-- ===========================================================================
-- 4.6  savings_transactions
-- ===========================================================================
-- INSERT: requires acknowledge_savings permission.
-- UPDATE / DELETE: allowed for Admin, OR for the original recorder while
-- they still hold acknowledge_savings.

DROP TRIGGER IF EXISTS trg_savings_bi;
DELIMITER //
CREATE TRIGGER trg_savings_bi BEFORE INSERT ON `savings_transactions`
FOR EACH ROW
BEGIN
  IF app_has_permission('acknowledge_savings') = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: you do not have permission to record savings';
  END IF;
  SET NEW.recorded_by      := @app_user_id;
  SET NEW.officer_initials := (SELECT initials FROM `users` WHERE id = @app_user_id);
END //

DROP TRIGGER IF EXISTS trg_savings_bu;
CREATE TRIGGER trg_savings_bu BEFORE UPDATE ON `savings_transactions`
FOR EACH ROW
BEGIN
  IF @app_role_name = 'Admin' THEN
    -- Admin may modify any row.
  ELSEIF @app_user_id IS NULL
      OR app_has_permission('acknowledge_savings') = 0
      OR OLD.recorded_by <> @app_user_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: you may only edit savings transactions you recorded';
  END IF;
END //

DROP TRIGGER IF EXISTS trg_savings_bd;
CREATE TRIGGER trg_savings_bd BEFORE DELETE ON `savings_transactions`
FOR EACH ROW
BEGIN
  IF @app_role_name = 'Admin' THEN
    -- Admin may delete any row.
  ELSEIF @app_user_id IS NULL
      OR app_has_permission('acknowledge_savings') = 0
      OR OLD.recorded_by <> @app_user_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: you may only delete savings transactions you recorded';
  END IF;
END //
DELIMITER ;


-- ===========================================================================
-- 4.7  loan_requests
-- ===========================================================================
-- INSERT: any authenticated officer (the request still needs Admin approval).
-- UPDATE: Admin may always update; the original requester may update only
--         while status = 'pending'.
-- DELETE: Admin only, and only while status = 'pending'.

DROP TRIGGER IF EXISTS trg_loan_requests_bi;
DELIMITER //
CREATE TRIGGER trg_loan_requests_bi BEFORE INSERT ON `loan_requests`
FOR EACH ROW
BEGIN
  IF @app_user_id IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: no app context — cannot submit loan request';
  END IF;
  SET NEW.requested_by          := @app_user_id;
  SET NEW.requested_by_initials := (SELECT initials FROM `users` WHERE id = @app_user_id);
END //

DROP TRIGGER IF EXISTS trg_loan_requests_bu;
CREATE TRIGGER trg_loan_requests_bu BEFORE UPDATE ON `loan_requests`
FOR EACH ROW
BEGIN
  IF @app_role_name = 'Admin' THEN
    -- Admin may always update (approval / remark / status change).
  ELSEIF @app_user_id IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: no app context — cannot update loan request';
  ELSEIF OLD.requested_by = @app_user_id AND OLD.status = 'pending' THEN
    -- Requester may edit their own pending request's *details* only
    -- (applicant name, telephone, address, category, term, amount, rate).
    -- They must NOT be able to change the request's status or approval
    -- fields — that requires Admin.
    IF NEW.status       <> OLD.status
       OR NEW.decided_by  <> OLD.decided_by
       OR (NEW.decision_date <> OLD.decision_date) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'RLS: only Admin may change a loan request''s status or approval fields';
    END IF;
  ELSE
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: you may only edit your own pending loan requests';
  END IF;
END //

DROP TRIGGER IF EXISTS trg_loan_requests_bd;
CREATE TRIGGER trg_loan_requests_bd BEFORE DELETE ON `loan_requests`
FOR EACH ROW
BEGIN
  IF @app_role_name <> 'Admin' OR @app_role_name IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: only Admin may delete loan requests';
  END IF;
  IF OLD.status <> 'pending' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: loan request is no longer pending — cannot delete';
  END IF;
END //
DELIMITER ;


-- ===========================================================================
-- 4.8  loans
-- ===========================================================================
-- INSERT: Admin only (loan disbursement follows Admin approval of a request).
-- UPDATE: Admin only.
-- DELETE: Admin only.

DROP TRIGGER IF EXISTS trg_loans_bi;
DELIMITER //
CREATE TRIGGER trg_loans_bi BEFORE INSERT ON `loans`
FOR EACH ROW
BEGIN
  IF @app_role_name <> 'Admin' OR @app_role_name IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: only Admin may disburse loans';
  END IF;
  SET NEW.disbursed_by        := @app_user_id;
  SET NEW.disbursed_initials  := (SELECT initials FROM `users` WHERE id = @app_user_id);
END //

DROP TRIGGER IF EXISTS trg_loans_bu;
CREATE TRIGGER trg_loans_bu BEFORE UPDATE ON `loans`
FOR EACH ROW
BEGIN
  IF @app_role_name <> 'Admin' OR @app_role_name IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: only Admin may modify loans';
  END IF;
END //

DROP TRIGGER IF EXISTS trg_loans_bd;
CREATE TRIGGER trg_loans_bd BEFORE DELETE ON `loans`
FOR EACH ROW
BEGIN
  IF @app_role_name <> 'Admin' OR @app_role_name IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: only Admin may delete loans';
  END IF;
END //
DELIMITER ;


-- ===========================================================================
-- 4.9  loan_repayments
-- ===========================================================================
-- INSERT: requires acknowledge_loan_repayments permission.
-- UPDATE / DELETE: allowed for Admin, OR for the original recorder while
-- they still hold acknowledge_loan_repayments.

DROP TRIGGER IF EXISTS trg_repayments_bi;
DELIMITER //
CREATE TRIGGER trg_repayments_bi BEFORE INSERT ON `loan_repayments`
FOR EACH ROW
BEGIN
  IF app_has_permission('acknowledge_loan_repayments') = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: you do not have permission to record loan repayments';
  END IF;
  SET NEW.recorded_by      := @app_user_id;
  SET NEW.officer_initials := (SELECT initials FROM `users` WHERE id = @app_user_id);
END //

DROP TRIGGER IF EXISTS trg_repayments_bu;
CREATE TRIGGER trg_repayments_bu BEFORE UPDATE ON `loan_repayments`
FOR EACH ROW
BEGIN
  IF @app_role_name = 'Admin' THEN
    -- Admin may modify any repayment.
  ELSEIF @app_user_id IS NULL
      OR app_has_permission('acknowledge_loan_repayments') = 0
      OR OLD.recorded_by <> @app_user_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: you may only edit repayments you recorded';
  END IF;
END //

DROP TRIGGER IF EXISTS trg_repayments_bd;
CREATE TRIGGER trg_repayments_bd BEFORE DELETE ON `loan_repayments`
FOR EACH ROW
BEGIN
  IF @app_role_name = 'Admin' THEN
    -- Admin may delete any repayment.
  ELSEIF @app_user_id IS NULL
      OR app_has_permission('acknowledge_loan_repayments') = 0
      OR OLD.recorded_by <> @app_user_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: you may only delete repayments you recorded';
  END IF;
END //
DELIMITER ;


-- ===========================================================================
-- 4.10  audit_log
-- ===========================================================================
-- INSERT: any authenticated session (every privileged action is logged).
-- UPDATE: forbidden for everyone — the audit log is immutable.
-- DELETE: Admin only (for FIFO purge of old entries beyond retention).

DROP TRIGGER IF EXISTS trg_audit_bi;
DELIMITER //
CREATE TRIGGER trg_audit_bi BEFORE INSERT ON `audit_log`
FOR EACH ROW
BEGIN
  IF @app_user_id IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: no app context — cannot write audit entry';
  END IF;
  SET NEW.user_id          := @app_user_id;
  SET NEW.user_name        := (SELECT full_name FROM `users` WHERE id = @app_user_id);
  SET NEW.user_email       := (SELECT email      FROM `users` WHERE id = @app_user_id);
  SET NEW.role_name        := @app_role_name;
  SET NEW.officer_initials := (SELECT initials   FROM `users` WHERE id = @app_user_id);
END //

DROP TRIGGER IF EXISTS trg_audit_bu;
CREATE TRIGGER trg_audit_bu BEFORE UPDATE ON `audit_log`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'RLS: audit log entries are immutable';
END //

DROP TRIGGER IF EXISTS trg_audit_bd;
CREATE TRIGGER trg_audit_bd BEFORE DELETE ON `audit_log`
FOR EACH ROW
BEGIN
  IF @app_role_name <> 'Admin' OR @app_role_name IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: only Admin may purge audit log entries';
  END IF;
END //
DELIMITER ;


-- ===========================================================================
-- 4.11  regulatory_inputs
-- ===========================================================================
-- INSERT / UPDATE / DELETE: Admin or Treasurer only.

DROP TRIGGER IF EXISTS trg_reg_inputs_bi;
DELIMITER //
CREATE TRIGGER trg_reg_inputs_bi BEFORE INSERT ON `regulatory_inputs`
FOR EACH ROW
BEGIN
  IF @app_role_name NOT IN ('Admin','Treasurer') OR @app_role_name IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: only Admin or Treasurer may enter regulatory inputs';
  END IF;
  SET NEW.entered_by := @app_user_id;
END //

DROP TRIGGER IF EXISTS trg_reg_inputs_bu;
CREATE TRIGGER trg_reg_inputs_bu BEFORE UPDATE ON `regulatory_inputs`
FOR EACH ROW
BEGIN
  IF @app_role_name NOT IN ('Admin','Treasurer') OR @app_role_name IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: only Admin or Treasurer may modify regulatory inputs';
  END IF;
END //

DROP TRIGGER IF EXISTS trg_reg_inputs_bd;
CREATE TRIGGER trg_reg_inputs_bd BEFORE DELETE ON `regulatory_inputs`
FOR EACH ROW
BEGIN
  IF @app_role_name NOT IN ('Admin','Treasurer') OR @app_role_name IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: only Admin or Treasurer may delete regulatory inputs';
  END IF;
END //
DELIMITER ;


-- ===========================================================================
-- 4.12  settings
-- ===========================================================================
-- INSERT / UPDATE: Admin or Treasurer.
-- DELETE: Admin only.

DROP TRIGGER IF EXISTS trg_settings_bi;
DELIMITER //
CREATE TRIGGER trg_settings_bi BEFORE INSERT ON `settings`
FOR EACH ROW
BEGIN
  IF @app_role_name NOT IN ('Admin','Treasurer') OR @app_role_name IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: only Admin or Treasurer may create settings';
  END IF;
  SET NEW.updated_by := @app_user_id;
END //

DROP TRIGGER IF EXISTS trg_settings_bu;
CREATE TRIGGER trg_settings_bu BEFORE UPDATE ON `settings`
FOR EACH ROW
BEGIN
  IF @app_role_name NOT IN ('Admin','Treasurer') OR @app_role_name IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: only Admin or Treasurer may modify settings';
  END IF;
  SET NEW.updated_by := @app_user_id;
END //

DROP TRIGGER IF EXISTS trg_settings_bd;
CREATE TRIGGER trg_settings_bd BEFORE DELETE ON `settings`
FOR EACH ROW
BEGIN
  IF @app_role_name <> 'Admin' OR @app_role_name IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'RLS: only Admin may delete settings';
  END IF;
END //
DELIMITER ;


-- ============================================================================
-- 5. PRIVILEGE GRANTS
-- ============================================================================
-- The application connects as a MySQL user that has been granted the
-- `sacco_app` role. The role receives:
--   * SELECT on every `_v` view (NOT on the base tables).
--   * INSERT / UPDATE / DELETE on the base tables (gated by triggers).
--   * EXECUTE on the helper functions and context procedures.
-- A separate `sacco_admin` role is intended for the System Admin to perform
-- ad-hoc operations directly (still gated by triggers — defence in depth).
-- ---------------------------------------------------------------------------

-- Application role (used by the SACCO web app's DB connection)
CREATE ROLE IF NOT EXISTS `sacco_app`;

-- Revoke any inherited privileges on base tables (defence in depth)
REVOKE ALL PRIVILEGES ON `elite_sacco`.* FROM `sacco_app`;

-- Grant SELECT on the filtered read-views
GRANT SELECT ON `elite_sacco`.`users_v`               TO `sacco_app`;
GRANT SELECT ON `elite_sacco`.`roles_v`               TO `sacco_app`;
GRANT SELECT ON `elite_sacco`.`role_permissions_v`    TO `sacco_app`;
GRANT SELECT ON `elite_sacco`.`members_v`             TO `sacco_app`;
GRANT SELECT ON `elite_sacco`.`non_members_v`         TO `sacco_app`;
GRANT SELECT ON `elite_sacco`.`savings_transactions_v` TO `sacco_app`;
GRANT SELECT ON `elite_sacco`.`loan_requests_v`       TO `sacco_app`;
GRANT SELECT ON `elite_sacco`.`loans_v`               TO `sacco_app`;
GRANT SELECT ON `elite_sacco`.`loan_repayments_v`     TO `sacco_app`;
GRANT SELECT ON `elite_sacco`.`audit_log_v`           TO `sacco_app`;
GRANT SELECT ON `elite_sacco`.`regulatory_inputs_v`   TO `sacco_app`;
GRANT SELECT ON `elite_sacco`.`settings_v`            TO `sacco_app`;

-- Grant writes on base tables (triggers enforce per-row authorisation)
GRANT INSERT, UPDATE, DELETE ON `elite_sacco`.`users`                TO `sacco_app`;
GRANT INSERT, UPDATE, DELETE ON `elite_sacco`.`roles`               TO `sacco_app`;
GRANT INSERT, UPDATE, DELETE ON `elite_sacco`.`role_permissions`    TO `sacco_app`;
GRANT INSERT, UPDATE, DELETE ON `elite_sacco`.`members`             TO `sacco_app`;
GRANT INSERT, UPDATE, DELETE ON `elite_sacco`.`non_members`          TO `sacco_app`;
GRANT INSERT, UPDATE, DELETE ON `elite_sacco`.`savings_transactions` TO `sacco_app`;
GRANT INSERT, UPDATE, DELETE ON `elite_sacco`.`loan_requests`       TO `sacco_app`;
GRANT INSERT, UPDATE, DELETE ON `elite_sacco`.`loans`               TO `sacco_app`;
GRANT INSERT, UPDATE, DELETE ON `elite_sacco`.`loan_repayments`     TO `sacco_app`;
GRANT INSERT, UPDATE, DELETE ON `elite_sacco`.`audit_log`           TO `sacco_app`;
GRANT INSERT, UPDATE, DELETE ON `elite_sacco`.`regulatory_inputs`   TO `sacco_app`;
GRANT INSERT, UPDATE, DELETE ON `elite_sacco`.`settings`            TO `sacco_app`;

-- Grant EXECUTE on helper functions and context procedures
GRANT EXECUTE ON PROCEDURE `elite_sacco`.`set_app_context`    TO `sacco_app`;
GRANT EXECUTE ON PROCEDURE `elite_sacco`.`clear_app_context`  TO `sacco_app`;
GRANT EXECUTE ON FUNCTION  `elite_sacco`.`app_user_id`        TO `sacco_app`;
GRANT EXECUTE ON FUNCTION  `elite_sacco`.`app_role_id`        TO `sacco_app`;
GRANT EXECUTE ON FUNCTION  `elite_sacco`.`app_role_name`      TO `sacco_app`;
GRANT EXECUTE ON FUNCTION  `elite_sacco`.`app_has_permission` TO `sacco_app`;
GRANT EXECUTE ON FUNCTION  `elite_sacco`.`app_is_admin`       TO `sacco_app`;

-- Optional administrator role for direct DBA access (still gated by triggers)
CREATE ROLE IF NOT EXISTS `sacco_admin`;
GRANT SELECT, INSERT, UPDATE, DELETE ON `elite_sacco`.* TO `sacco_admin`;
GRANT EXECUTE ON `elite_sacco`.* TO `sacco_admin`;


-- ============================================================================
-- 6. APPLICATION INTEGRATION — quick reference (not executed here)
-- ============================================================================
-- Typical application request lifecycle:
--
--   -- 1. User logs in; app validates password against users.password_hash.
--   -- 2. App opens a pooled DB connection (already authenticated as the
--   --      `sacco_app` MySQL user) and immediately calls:
--   CALL set_app_context(<authenticated_user_id>);
--   -- 3. App performs the request's queries through the `_v` views and
--   --      writes to the base tables; triggers enforce RLS.
--   -- 4. Before returning the connection to the pool:
--   CALL clear_app_context();
--
-- Example: a Credit Officer records a member deposit:
--   CALL set_app_context(4);                       -- Credit Officer user id
--   INSERT INTO savings_transactions
--     (reference_no, member_id, account_number, amount, is_withdrawal,
--      transaction_date, channel)
--   VALUES ('SV-000001', 1, 'ES-F 000001', 50000, 0, NOW(), 'counter_cash');
--   -- trg_savings_bi verifies acknowledge_savings and stamps recorded_by.
--
-- Example: the same Credit Officer tries to disburse a loan (must fail):
--   INSERT INTO loans (...) VALUES (...);
--   -- ERROR 1644: RLS: only Admin may disburse loans
-- ============================================================================


-- ============================================================================
-- 7. VERIFICATION (uncomment to smoke-test the policies after import)
-- ============================================================================
-- -- As the SACCO application user (after `GRANT sacco_app TO ...; SET ROLE sacco_app;`):
--
-- -- (a) No context  → every operation should fail.
-- -- INSERT INTO non_members (full_name) VALUES ('Nobody');
-- -- -- ERROR 1644: RLS: no app context — cannot create non-member
--
-- -- (b) Credit Officer context
-- -- CALL set_app_context(4);   -- assuming user id 4 is a Credit Officer
-- -- SELECT COUNT(*) FROM users_v;              -- returns 1 (own row only)
-- -- SELECT COUNT(*) FROM audit_log_v;          -- returns 0 (no read access)
-- -- SELECT COUNT(*) FROM settings_v;           -- returns 0 (no read access)
-- -- INSERT INTO non_members (full_name) VALUES ('John Visitor');  -- OK
-- -- INSERT INTO savings_transactions (...) VALUES (...);           -- OK
-- -- INSERT INTO loans (...) VALUES (...);                          -- ERROR 1644
-- -- UPDATE users SET full_name='X' WHERE id=1;                    -- ERROR 1644
--
-- -- (c) Admin context
-- -- CALL set_app_context(1);
-- -- SELECT COUNT(*) FROM users_v;              -- returns all users
-- -- SELECT COUNT(*) FROM audit_log_v;          -- returns all entries
-- -- INSERT INTO loans (...) VALUES (...);      -- OK
-- -- UPDATE audit_log SET action='x' WHERE id=1; -- ERROR 1644 (immutable)
-- --
-- -- CALL clear_app_context();
-- ============================================================================

-- End of policies.sql
