-- server/db/queries/users.sql
-- User queries and helper functions for Elite SACCO Mbarara.

-- ============================================================
-- User summary view
-- ============================================================

CREATE OR REPLACE VIEW v_user_summary AS
SELECT
  u.id,
  u.name,
  u.email,
  u.role::TEXT AS role,
  u.initials,
  u.is_active,
  u.created_at,
  u.updated_at,
  u.last_login_at
FROM users u
ORDER BY u.name;

-- ============================================================
-- Fetch a single user by email (without exposing password hash)
-- ============================================================

CREATE OR REPLACE FUNCTION user_by_email(p_email TEXT)
RETURNS TABLE (
  id INTEGER,
  name TEXT,
  email TEXT,
  role TEXT,
  initials TEXT,
  is_active BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    u.id,
    u.name,
    u.email,
    u.role::TEXT,
    u.initials,
    u.is_active,
    u.created_at,
    u.updated_at,
    u.last_login_at
  FROM users u
  WHERE LOWER(u.email) = LOWER(p_email)
  LIMIT 1;
END;
$$;

-- ============================================================
-- Fetch a single user by id
-- ============================================================

CREATE OR REPLACE FUNCTION user_by_id(p_user_id INTEGER)
RETURNS TABLE (
  id INTEGER,
  name TEXT,
  email TEXT,
  role TEXT,
  initials TEXT,
  is_active BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    u.id,
    u.name,
    u.email,
    u.role::TEXT,
    u.initials,
    u.is_active,
    u.created_at,
    u.updated_at,
    u.last_login_at
  FROM users u
  WHERE u.id = p_user_id
  LIMIT 1;
END;
$$;

-- ============================================================
-- Search users by name/email
-- ============================================================

CREATE OR REPLACE FUNCTION user_search(
  p_term TEXT DEFAULT NULL
)
RETURNS TABLE (
  id INTEGER,
  name TEXT,
  email TEXT,
  role TEXT,
  initials TEXT,
  is_active BOOLEAN,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    u.id,
    u.name,
    u.email,
    u.role::TEXT,
    u.initials,
    u.is_active,
    u.created_at
  FROM users u
  WHERE p_term IS NULL
     OR LOWER(u.name) LIKE '%' || LOWER(p_term) || '%'
     OR LOWER(u.email) LIKE '%' || LOWER(p_term) || '%'
  ORDER BY u.name;
END;
$$;

-- ============================================================
-- User stats
-- ============================================================

CREATE OR REPLACE FUNCTION user_stats()
RETURNS TABLE (
  total_users BIGINT,
  active_users BIGINT,
  inactive_users BIGINT,
  admin_users BIGINT,
  member_users BIGINT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::BIGINT AS total_users,
    COUNT(*) FILTER (WHERE is_active = TRUE)::BIGINT AS active_users,
    COUNT(*) FILTER (WHERE is_active = FALSE)::BIGINT AS inactive_users,
    COUNT(*) FILTER (WHERE role = 'Admin')::BIGINT AS admin_users,
    COUNT(*) FILTER (WHERE role = 'Member')::BIGINT AS member_users
  FROM users;
END;
$$;

-- ============================================================
-- Update last login timestamp
-- ============================================================

CREATE OR REPLACE FUNCTION mark_user_login(p_user_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE users
     SET last_login_at = NOW(),
         updated_at = NOW()
   WHERE id = p_user_id;
END;
$$;

-- ============================================================
-- Examples
-- ============================================================

-- Get all users:
-- SELECT *
-- FROM v_user_summary;

-- Find a user by email:
-- SELECT *
-- FROM user_by_email('admin@elitesacco.co.ug');

-- Search users:
-- SELECT *
-- FROM user_search('admin');

-- Stats:
-- SELECT *
-- FROM user_stats();

-- Mark login:
-- SELECT mark_user_login(1);
