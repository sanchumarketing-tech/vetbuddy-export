-- 13: conversation memory for the Teams assistant (last turns per chat; kept 14 days, read 3 hours back)
create table if not exists vetbuddy.bot_turns (
  id           bigserial primary key,
  conversation text not null,
  at           timestamptz not null default now(),
  role         text not null check (role in ('user', 'bot')),
  text         text not null
);
create index if not exists bot_turns_conv_at on vetbuddy.bot_turns (conversation, at desc);
grant select, insert, delete on vetbuddy.bot_turns to vb_teams;
grant usage on sequence vetbuddy.bot_turns_id_seq to vb_teams;
