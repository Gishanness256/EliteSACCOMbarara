-- Demo seed data for Elite SACCO Mbarara
-- Run after schema.sql is applied.

BEGIN;

-- 1) Demo admin user
-- Password: Admin (hash generated via PostgreSQL pgcrypto)
INSERT INTO users (name, email, role, initials, password_hash, is_active)
SELECT
  'System Admin',
  'admin@elitesacco.co.ug',
  'Admin',
  'SA',
  crypt('Admin', gen_salt('bf', 12)),
  TRUE
WHERE NOT EXISTS (
  SELECT 1
  FROM users
  WHERE email = 'admin@elitesacco.co.ug'
);

-- 2) Default regulatory templates
INSERT INTO regulatory_return_templates (name, short_name, description, is_active, sort_order)
SELECT 'Monthly Return', 'M', 'Monthly cooperative return summary', TRUE, 10
WHERE NOT EXISTS (
  SELECT 1
  FROM regulatory_return_templates
  WHERE short_name = 'M'
);

INSERT INTO regulatory_return_templates (name, short_name, description, is_active, sort_order)
SELECT 'Quarterly Return', 'Q', 'Quarterly regulatory return', TRUE, 20
WHERE NOT EXISTS (
  SELECT 1
  FROM regulatory_return_templates
  WHERE short_name = 'Q'
);

INSERT INTO regulatory_return_templates (name, short_name, description, is_active, sort_order)
SELECT 'Annual Return', 'Y', 'Annual year-end return', TRUE, 30
WHERE NOT EXISTS (
  SELECT 1
  FROM regulatory_return_templates
  WHERE short_name = 'Y'
);

COMMIT;
