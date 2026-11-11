-- 08  Follow-up questions: each Teams chat remembers its last question (place, period, question type)
CREATE TABLE IF NOT EXISTS vetbuddy.bot_context (
  conversation text PRIMARY KEY,
  key          text NOT NULL,
  question     text NOT NULL,
  units        text[] NOT NULL,
  place_label  text NOT NULL,
  p_from       date NOT NULL,
  p_to         date NOT NULL,
  p_kind       text NOT NULL,
  p_label      text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON vetbuddy.bot_context TO vb_teams, vb_bot;
