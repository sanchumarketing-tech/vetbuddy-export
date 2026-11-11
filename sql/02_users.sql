-- =====================================================================
-- Two database logins with only the rights each needs.
-- Run ONCE in the Supabase SQL Editor, AFTER 01_schema.sql.
-- Replace both passwords with long random ones first (letters + digits only
-- is easiest, because they go into a connection address).
-- =====================================================================

-- 1. Loader – used by the daily GitHub Action: may replace rows, nothing else
CREATE ROLE vb_loader WITH LOGIN PASSWORD 'REPLACEwithLongRandomPassword1';
GRANT USAGE ON SCHEMA vetbuddy TO vb_loader;
GRANT SELECT, INSERT, DELETE ON vetbuddy.sales, vetbuddy.load_log TO vb_loader;
GRANT USAGE ON SEQUENCE vetbuddy.sales_id_seq, vetbuddy.load_log_id_seq TO vb_loader;

-- 2. Bot – used by the Teams bot: may only READ the privacy-safe views
CREATE ROLE vb_bot WITH LOGIN PASSWORD 'REPLACEwithLongRandomPassword2';
GRANT USAGE ON SCHEMA vetbuddy TO vb_bot;
GRANT SELECT ON vetbuddy.v_sales_bot, vetbuddy.v_data_freshness TO vb_bot;
ALTER ROLE vb_bot SET default_transaction_read_only = on;   -- can never change data
ALTER ROLE vb_bot SET statement_timeout = '20s';            -- no runaway queries
-- (vb_bot has no rights on vetbuddy.sales itself, so phone/email are unreachable)
