-- 15: Teams bot v3 - one row per question (tools used, models, tokens, reply time, errors, "wrong" feedback)
create table if not exists vetbuddy.bot_log (
  id           bigserial primary key,
  at           timestamptz not null default now(),
  conversation text,
  who          text,
  question     text,
  reply        text,
  tools        jsonb,
  models       text,
  tokens       int,
  ms           int,
  ok           boolean,
  error        text,
  feedback     text
);
create index if not exists bot_log_at on vetbuddy.bot_log (at desc);
grant select, insert, update on vetbuddy.bot_log to vb_teams;
grant usage on sequence vetbuddy.bot_log_id_seq to vb_teams;
select 'bot_log ok' as result;
