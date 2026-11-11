-- 06  A separate read-only login for the Teams bot (vb_bot is not changed).
-- Replace TYPE-NEW-PASSWORD-HERE (letters and numbers only, 20+ characters), then Run once.
CREATE ROLE vb_teams WITH LOGIN PASSWORD 'TYPE-NEW-PASSWORD-HERE';
ALTER ROLE vb_teams SET default_transaction_read_only = on;
ALTER ROLE vb_teams SET statement_timeout = '20s';
GRANT USAGE ON SCHEMA vetbuddy, extensions TO vb_teams;
GRANT SELECT ON vetbuddy.v_sales_bot, vetbuddy.v_pharmacy_bot, vetbuddy.v_all_sales, vetbuddy.v_data_freshness,
                vetbuddy.sheet_daily, vetbuddy.sheet_targets, vetbuddy.sheet_kpi, vetbuddy.sheet_sync_log,
                vetbuddy.v_report_check TO vb_teams;
GRANT SELECT, INSERT, UPDATE ON vetbuddy.bot_memory, vetbuddy.bot_usage TO vb_teams;
GRANT USAGE ON SEQUENCE vetbuddy.bot_memory_id_seq TO vb_teams;
