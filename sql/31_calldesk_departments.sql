-- Call Desk agent departments (20 Nov 2026) - already applied to the live database.
-- Only departments with calls = true get call lists (build_list, balance_lists, rebalance_today check it).
-- Function changes are in sql/live/ (cd_team, cd_incentives, cd_agent_save, build_list, balance_lists, rebalance_today).

create table if not exists calldesk.departments (name text primary key, sort int not null default 0, calls boolean not null default false);
alter table calldesk.departments enable row level security;
insert into calldesk.departments (name, sort, calls) values ('Sharpshooting', 1, true), ('Inbound', 2, false), ('Social Media', 3, false), ('Chat', 4, false)
on conflict (name) do nothing;
alter table calldesk.agents add column if not exists department text references calldesk.departments (name) on update cascade;

-- To switch on call lists for another department later:
--   update calldesk.departments set calls = true where name = 'Inbound';

-- Departments from the "Agent Department" sheet (by agent id). M.swetha (34), Shanbagavalli (36) and
-- Shunmuga Sundari (33) were not in the sheet and were kept on Sharpshooting.
update calldesk.agents set department = 'Sharpshooting' where id in (52,17,15,13,12,19,14,27,20,22,26,25,24,21,7,23,18,16,32,31,30,9,34,36,33);
update calldesk.agents set department = 'Inbound' where id in (29,11);
update calldesk.agents set department = 'Social Media' where id in (10,8);
update calldesk.agents set department = 'Chat' where id in (28,35);

-- VetBuddy logins added from the "Agent Lookup" sheet (kept with what each agent already had)
update calldesk.agents g set vb_logins = (select array_agg(distinct x) from unnest(coalesce(g.vb_logins, '{}') || v.add) x)
  from (values (52, array['Kaviya','saikaviya02@gmail.com']), (26, array['dharshu1306@gmail.com']), (9, array['Sahana']),
               (28, array['saranya@sanchu.co.in','Saranya']), (11, array['Sowmiya']), (21, array['Supriya']), (20, array['Shamszehra']),
               (22, array['kavidhanush16@gmail.com']), (18, array['Lakshmi']), (19, array['mdhivya856@gmail.com']),
               (34, array['swetharajkumar623@gmail.com']), (25, array['ramezsh.pavi13@gmail.com']), (29, array['jayashree_sanchu'])) v(id, add)
 where g.id = v.id;
