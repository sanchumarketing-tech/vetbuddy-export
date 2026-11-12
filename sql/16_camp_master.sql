-- 16: Camp master - filled from SharePoint "Sanchu Reports/Camp Master.xlsx" by camp_master_sync.py (GitHub Actions)
--     one row per camp item; the Teams bot uses it to explain camp days and measure camp performance.
create table if not exists vetbuddy.camp_master (
  row_no           int,
  camp_name        text not null,
  camp_type        text,
  camp_dates       date[] not null,
  locations        text,
  units            text[] not null,          -- sales units the camp covers (from Locations)
  item             text not null,
  goods_or_service text,
  match_keywords   text[] not null,          -- text found in VetBuddy / pharmacy item names (case-insensitive)
  species          text,
  original_price   numeric,
  camp_price       numeric,
  notes            text,
  loaded_at        timestamptz not null default now()
);
create index if not exists camp_master_dates on vetbuddy.camp_master using gin (camp_dates);

-- one row per camp day
create or replace view vetbuddy.v_camp_days as
select camp_name, d::date as camp_date, string_agg(distinct camp_type, ' + ') as camp_type,
       string_agg(distinct locations, '; ') as locations, count(*) as items
from vetbuddy.camp_master, unnest(camp_dates) d
group by 1, 2;

grant select, insert, delete on vetbuddy.camp_master to vb_loader;
grant select on vetbuddy.camp_master, vetbuddy.v_camp_days to vb_teams;
select 'camp_master ok' as result;
