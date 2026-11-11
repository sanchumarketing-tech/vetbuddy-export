-- =====================================================================
-- 04  Numbers from the Google Sheet "Daily Sales Report" -> Supabase
--     (for the Teams bot: targets, the report's daily unit totals with the
--      manual VOW corrections, and the month KPIs exactly as the Summary shows)
-- Run ONCE in the Supabase SQL Editor, after 01, 02 and 03.
-- The sheet sends its numbers every morning after the 9 AM import through the
-- function public.sheet_push(...). That function only accepts a secret push key
-- (made at the end of this file) and can only replace these sheet_* tables.
-- =====================================================================

-- daily totals per unit, exactly as the sheet "Data" (= the Summary table)
CREATE TABLE IF NOT EXISTS vetbuddy.sheet_daily (
  sale_date  date    NOT NULL,
  unit       text    NOT NULL,          -- ADYAR ... CH VET ON WHEELS, CH VET ON WHEELS - NON CLINICAL ...
  total      numeric NOT NULL,          -- what the Summary shows for that day and unit
  vetbuddy   numeric,                   -- VetBuddy part (NULL for old history rows)
  gofrugal   numeric,                   -- Gofrugal pharmacy part, after returns (NULL for old history)
  PRIMARY KEY (sale_date, unit)
);

-- monthly targets ("Target @ 2 Cr") per unit, from the sheet "AOP"
CREATE TABLE IF NOT EXISTS vetbuddy.sheet_targets (
  month   date    NOT NULL,             -- first day of the month
  unit    text    NOT NULL,
  target  numeric NOT NULL,
  PRIMARY KEY (month, unit)
);

-- the Summary KPI block per unit (unit 'TOTAL' = division), for this month and last month
CREATE TABLE IF NOT EXISTS vetbuddy.sheet_kpi (
  month                    date    NOT NULL,
  unit                     text    NOT NULL,
  as_of                    date,
  days_done                int,
  days_left                int,
  mtd                      numeric,   -- month to date
  last_month_same_days     numeric,
  two_months_same_days     numeric,
  growth_vs_last_month     numeric,   -- 0.12 = +12 %
  growth_vs_two_months     numeric,
  month_estimate           numeric,   -- MON EST
  target                   numeric,   -- Target @ 2 Cr
  estimate_vs_target       numeric,
  balance_to_target        numeric,
  required_per_day         numeric,
  ads                      numeric,   -- average daily sales
  ads_last_month           numeric,
  target_per_day           numeric,
  ads_vs_target            numeric,
  vetbuddy_mtd             numeric,
  gofrugal_mtd             numeric,
  PRIMARY KEY (month, unit)
);

CREATE TABLE IF NOT EXISTS vetbuddy.sheet_sync_log (
  id         bigserial PRIMARY KEY,
  pushed_at  timestamptz NOT NULL DEFAULT now(),
  daily_rows int, target_rows int, kpi_rows int
);

CREATE TABLE IF NOT EXISTS vetbuddy.sheet_push_key (
  id        int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  key_hash  text NOT NULL,
  made_at   timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON vetbuddy.sheet_push_key FROM PUBLIC;

-- ---------------------------------------------------------------------
-- the only door from the sheet: replaces the sheet_* tables in one go
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sheet_push(p_key text, p_daily jsonb, p_targets jsonb, p_kpi jsonb)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE nd int := 0; nt int := 0; nk int := 0;
BEGIN
  IF p_key IS NULL OR NOT EXISTS (SELECT 1 FROM vetbuddy.sheet_push_key
                                  WHERE key_hash = encode(sha256(convert_to(p_key, 'UTF8')), 'hex')) THEN
    RAISE EXCEPTION 'wrong push key';
  END IF;

  IF p_daily IS NOT NULL AND jsonb_array_length(p_daily) > 0 THEN
    DELETE FROM vetbuddy.sheet_daily WHERE true;      -- Supabase blocks DELETE without WHERE
    INSERT INTO vetbuddy.sheet_daily (sale_date, unit, total, vetbuddy, gofrugal)
    SELECT x.d, x.u, x.t, x.v, x.g FROM jsonb_to_recordset(p_daily) AS x(d date, u text, t numeric, v numeric, g numeric);
    GET DIAGNOSTICS nd = ROW_COUNT;
  END IF;

  IF p_targets IS NOT NULL AND jsonb_array_length(p_targets) > 0 THEN
    DELETE FROM vetbuddy.sheet_targets WHERE true;
    INSERT INTO vetbuddy.sheet_targets (month, unit, target)
    SELECT x.m, x.u, x.t FROM jsonb_to_recordset(p_targets) AS x(m date, u text, t numeric);
    GET DIAGNOSTICS nt = ROW_COUNT;
  END IF;

  IF p_kpi IS NOT NULL AND jsonb_array_length(p_kpi) > 0 THEN
    DELETE FROM vetbuddy.sheet_kpi WHERE month IN (SELECT DISTINCT (e->>'month')::date FROM jsonb_array_elements(p_kpi) e);
    INSERT INTO vetbuddy.sheet_kpi
    SELECT * FROM jsonb_populate_recordset(NULL::vetbuddy.sheet_kpi, p_kpi);
    GET DIAGNOSTICS nk = ROW_COUNT;
  END IF;

  INSERT INTO vetbuddy.sheet_sync_log (daily_rows, target_rows, kpi_rows) VALUES (nd, nt, nk);
  RETURN format('ok: %s daily, %s targets, %s kpi rows', nd, nt, nk);
END $$;

REVOKE ALL ON FUNCTION public.sheet_push(text, jsonb, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sheet_push(text, jsonb, jsonb, jsonb) TO anon;

-- the bot may read the sheet numbers
GRANT SELECT ON vetbuddy.sheet_daily, vetbuddy.sheet_targets, vetbuddy.sheet_kpi, vetbuddy.sheet_sync_log TO vb_bot;

-- ---------------------------------------------------------------------
-- make the push key: the result shows the key ONCE. Copy it into the sheet:
-- Sales Report > SharePoint auto import > Set Supabase (bot) login.
-- Running this again makes a new key (the old one stops working).
-- ---------------------------------------------------------------------
WITH k AS (SELECT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') AS key),
ins AS (
  INSERT INTO vetbuddy.sheet_push_key (id, key_hash)
  SELECT 1, encode(sha256(convert_to(key, 'UTF8')), 'hex') FROM k
  ON CONFLICT (id) DO UPDATE SET key_hash = EXCLUDED.key_hash, made_at = now()
  RETURNING 1
)
SELECT 'COPY THIS PUSH KEY: ' || key AS push_key FROM k, ins;
