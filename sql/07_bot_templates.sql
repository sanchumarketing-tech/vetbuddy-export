-- 07  Bot memory v2: saved query templates (re-used for any place/period) + saved insights
ALTER TABLE vetbuddy.bot_memory ADD COLUMN IF NOT EXISTS detail_sql text;
ALTER TABLE vetbuddy.bot_memory ADD COLUMN IF NOT EXISTS answer text;
UPDATE vetbuddy.bot_memory SET good = false WHERE good;          -- old single-number answers are retired

CREATE TABLE IF NOT EXISTS vetbuddy.bot_insight (
  key        text PRIMARY KEY,      -- memory id | units | from | to | data date
  memory_id  bigint REFERENCES vetbuddy.bot_memory(id),
  insight    text NOT NULL,
  tokens     int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON vetbuddy.bot_insight TO vb_teams, vb_bot;
