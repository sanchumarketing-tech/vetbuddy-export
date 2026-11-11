-- =============================================================================
-- 12  Analyst bot: saved query plans + saved analyses (run once; safe to re-run)
-- =============================================================================
CREATE TABLE IF NOT EXISTS vetbuddy.bot_plan (
  signature    text PRIMARY KEY,               -- question type (+insight)
  question     text,
  plan         jsonb NOT NULL,                 -- {"understanding": "...", "queries": [{"purpose","sql"}]} with placeholders
  good         boolean NOT NULL DEFAULT true,  -- false after someone replies "wrong"
  uses         int NOT NULL DEFAULT 0,
  tokens       int,
  asked_by     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS vetbuddy.bot_answer (  -- finished analysis per question type + units + dates + data date
  cache_key  text PRIMARY KEY,
  plan_sig   text,
  answer     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_bot_answer_sig ON vetbuddy.bot_answer (plan_sig);
ALTER TABLE vetbuddy.bot_context ADD COLUMN IF NOT EXISTS headline text;

GRANT SELECT, INSERT, UPDATE, DELETE ON vetbuddy.bot_plan, vetbuddy.bot_answer TO vb_teams;
GRANT DELETE ON vetbuddy.bot_context TO vb_teams;

-- clean up: old single-query templates that came from small talk / mixed-up follow-ups, and old conversations
UPDATE vetbuddy.bot_memory SET good = false WHERE id IN (7, 9, 10, 11, 12, 14, 15);
DELETE FROM vetbuddy.bot_context;

SELECT 'bot_plan / bot_answer ready' AS status,
       has_table_privilege('vb_teams', 'vetbuddy.bot_plan', 'insert') AS teams_can_save_plans,
       has_table_privilege('vb_teams', 'vetbuddy.bot_answer', 'insert') AS teams_can_save_answers,
       has_table_privilege('vb_teams', 'vetbuddy.bot_context', 'delete') AS teams_can_reset_chat;
