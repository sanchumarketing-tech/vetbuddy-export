-- 14: house rules ("negative prompts") for the Teams bot - added to every AI step; managed from Teams:
--     "rules"  |  "add rule: never ..."  |  "remove rule 2"   (or edit this table in Supabase)
create table if not exists vetbuddy.bot_rules (
  id         serial primary key,
  rule       text not null,
  active     boolean not null default true,
  created_by text,
  created_at timestamptz not null default now()
);
grant select, insert, update on vetbuddy.bot_rules to vb_teams;
grant usage on sequence vetbuddy.bot_rules_id_seq to vb_teams;
grant delete on vetbuddy.bot_answer to vb_teams;

insert into vetbuddy.bot_rules (rule, created_by)
select r, 'setup' from (values
  ('Never answer for a different date, period, unit or comparison than the one asked. If the question names a day, answer for that day only.'),
  ('Never add a "same day last month" or any other comparison the person did not ask for.'),
  ('Never show tables, splits, unit-wise lists or charts unless the person asked for a breakdown, list, ranking or comparison.'),
  ('Never give advice or "what to do" suggestions unless the person asked for insights or suggestions.'),
  ('Never guess or estimate a number. If the data does not cover the question, say what is missing.'),
  ('Never use emojis, slang or casual phrases. Keep a professional, courteous tone.'),
  ('Never write unit names in capital letters - use Title Case (Anna Nagar, CH Vet on Wheels).'),
  ('Never mention SQL, queries, tables, AI models or tokens.')
) v(r)
where not exists (select 1 from vetbuddy.bot_rules);

select id, rule from vetbuddy.bot_rules order by id;
