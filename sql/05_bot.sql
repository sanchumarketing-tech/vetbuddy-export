-- =====================================================================
-- 05  Teams bot: safety settings for the read-only login + daily check
-- Run ONCE in the Supabase SQL Editor, after 04_sheet_numbers.sql.
-- =====================================================================

-- the bot login can never write and never runs a query longer than 20 seconds
ALTER ROLE vb_bot SET default_transaction_read_only = on;
ALTER ROLE vb_bot SET statement_timeout = '20s';

-- ---------------------------------------------------------------------
-- Daily check: does the detail data (v_all_sales) still add up to the report
-- (sheet_daily) for every day and unit?  Only differences of Rs 1 or more are listed.
-- Typical reasons: late bills (VetBuddy changed after the 9 AM import), the manual
-- VOW corrections in the sheet's Settings, or the Non Clinical split.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW vetbuddy.v_report_check AS
WITH rng AS (
  SELECT GREATEST((SELECT min(sale_date) FROM vetbuddy.v_all_sales),
                  (SELECT min(sale_date) FROM vetbuddy.sheet_daily WHERE vetbuddy IS NOT NULL)) AS d0,
         (SELECT max(sale_date) FROM vetbuddy.sheet_daily) AS d1
),
s AS (
  SELECT sale_date, unit, total FROM vetbuddy.sheet_daily, rng
  WHERE vetbuddy IS NOT NULL AND sale_date BETWEEN rng.d0 AND rng.d1
),
d AS (
  SELECT sale_date, sales_unit AS unit, SUM(amount) AS total
  FROM vetbuddy.v_all_sales, rng
  WHERE sales_unit NOT LIKE '%UNMAPPED%' AND sale_date BETWEEN rng.d0 AND rng.d1
  GROUP BY 1, 2
)
SELECT COALESCE(s.sale_date, d.sale_date) AS sale_date,
       COALESCE(s.unit, d.unit)           AS unit,
       s.total                            AS report_total,
       d.total                            AS detail_total,
       ROUND(COALESCE(d.total, 0) - COALESCE(s.total, 0), 2) AS difference
FROM s FULL JOIN d ON s.sale_date = d.sale_date AND s.unit = d.unit
WHERE abs(COALESCE(d.total, 0) - COALESCE(s.total, 0)) >= 1;

GRANT SELECT ON vetbuddy.v_report_check TO vb_bot;

-- ---------------------------------------------------------------------
-- Bot memory: every question the AI answered, with its SQL (re-run for fresh numbers)
-- and any insight it wrote. A repeated or reworded question re-uses the SQL
-- without calling the AI at all (no tokens).
-- ---------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS vetbuddy.bot_memory (
  id            bigserial PRIMARY KEY,
  question      text NOT NULL,          -- as asked the first time
  signature     text NOT NULL,          -- normalised key words (sorted) = how repeats are found
  sql           text NOT NULL,
  title         text,
  insight       text,                   -- AI insight (only when asked), for the data date below
  insight_asof  date,
  uses          int  NOT NULL DEFAULT 1,
  tokens        int  NOT NULL DEFAULT 0, -- tokens spent on this question so far
  good          boolean NOT NULL DEFAULT true,  -- false after someone replies "wrong"
  asked_by      text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_bot_memory_sig ON vetbuddy.bot_memory (signature) WHERE good;
CREATE INDEX IF NOT EXISTS ix_bot_memory_trgm ON vetbuddy.bot_memory USING gin (signature extensions.gin_trgm_ops);

-- token use per day (to stay inside the free Groq limit)
CREATE TABLE IF NOT EXISTS vetbuddy.bot_usage (
  day     date PRIMARY KEY,
  tokens  int NOT NULL DEFAULT 0,
  calls   int NOT NULL DEFAULT 0
);

-- the bot login may write ONLY these two tables (in an explicit read-write transaction;
-- the AI's own queries always run read-only)
GRANT SELECT, INSERT, UPDATE ON vetbuddy.bot_memory, vetbuddy.bot_usage TO vb_bot;
GRANT USAGE ON SEQUENCE vetbuddy.bot_memory_id_seq TO vb_bot;
GRANT USAGE ON SCHEMA extensions TO vb_bot;
