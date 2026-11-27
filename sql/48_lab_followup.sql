-- =====================================================================
-- 48  Lab Abnormal Follow-up board (27 Nov 2026)
--
--   lab.reports   abnormal lab reports from the Lab Test Tracker (SharePoint), one row per pet per report
--                 date (tests of the same day combined). Loaded every morning by lab_tracker_load.py.
--   lab.board     the open list: pets with an abnormal report on or after the board's start date that have
--                 NOT had a VetBuddy bill (same client + pet id) after the report date. Rebuilt by
--                 lab.refresh() after the morning loads (VetBuddy is day-1, so once a day is exact).
--   lab.done      pets that left the list (their first VetBuddy visit after the report) - for the counts.
--   public.lf_board()  what the website reads. Same login as the Call Desk (calldesk.me()):
--                 team leads see every unit, agents see their own units.
--   Today's calls (green) come from the "RUNO Call Log Live" Google Sheet in the website, not from here.
-- Small: about 15 reports a day (≈ 1 MB a year). Safe to run again.
-- =====================================================================

create schema if not exists lab;
revoke all on schema lab from public, anon, authenticated;

create table if not exists lab.settings (
  key   text primary key,
  value text not null
);
-- the board starts with the last 30 days (chosen 27 Nov 2026)
insert into lab.settings values ('start_date', '2026-10-28') on conflict (key) do nothing;

create table if not exists lab.reports (
  report_date date not null,
  client_id   text not null,          -- tracker "Client ID"
  pet_id      text not null,          -- tracker "Pet ID"
  pet_name    text,
  clinic      text,                   -- tracker "Clinic Name"
  unit        text,                   -- the same unit names as vetbuddy.sales.sales_unit / calldesk.agents.units
  tests       text,                   -- abnormal tests of that day, comma separated
  n_tests     int,
  remarks     text,
  loaded_at   timestamptz not null default now(),
  primary key (report_date, client_id, pet_id)
);

create table if not exists lab.board (
  vb_key        text primary key,      -- VetBuddy client id as it is in sales: "<client> (<pet>)"
  unit          text,
  clinic        text,
  client_id     text,
  pet_id        text,
  pet_name      text,
  client_name   text,
  phone         text,
  first_report  date,
  last_report   date,
  n_reports     int,
  tests         text,
  remarks       text,
  calls_before  int,                   -- Runo outgoing calls to the phone from the first report to yesterday
  answered_before int,
  last_call_at  timestamp,
  last_call_by  text,
  built_at      timestamptz not null default now()
);

create table if not exists lab.done (
  vb_key       text not null,
  last_report  date not null,
  unit         text,
  pet_name     text,
  phone        text,
  visit_date   date,
  visit_unit   text,
  calls_before int,
  closed_on    date not null,
  primary key (vb_key, last_report)
);

create table if not exists lab.load_log (
  id          serial primary key,
  loaded_at   timestamptz not null default now(),
  rows_in     int,
  reports     int,
  last_report date,
  note        text
);

revoke all on all tables in schema lab from public, anon, authenticated;

-- tracker "Clinic Name" -> unit
create or replace function lab.unit_of(p text) returns text
language sql immutable as $$
  select case
    when p is null then null
    when lower(p) like '%coimbatore%' and lower(p) like '%wheel%' then 'CBE VET ON WHEELS'
    when lower(p) like '%madurai%'    and lower(p) like '%wheel%' then 'MADURAI VET ON WHEELS'
    when lower(p) like '%wheel%' or lower(p) like '%vow%'        then 'CH VET ON WHEELS'
    when lower(p) like '%palavakkam%' or lower(p) like '%neelan%' then 'NEELANGARAI'
    else upper(trim(p)) end
$$;

-- Rebuilds lab.board (and moves pets that came back to lab.done). Called by the morning job.
create or replace function lab.refresh() returns jsonb
language plpgsql volatile security definer set search_path = lab, public as $$
declare
  d0 date := (select value::date from lab.settings where key = 'start_date');
  today date := (now() at time zone 'Asia/Kolkata')::date;
  n_open int; n_closed int;
begin
  -- pets with an abnormal report since the start date, latest report per pet
  create temp table _r on commit drop as
  select client_id || ' (' || pet_id || ')' vb_key, client_id, pet_id,
         min(report_date) first_report, max(report_date) last_report, count(distinct report_date) n_reports,
         (array_agg(pet_name order by report_date desc))[1] pet_name,
         (array_agg(clinic   order by report_date desc))[1] clinic,
         (array_agg(unit     order by report_date desc))[1] unit,
         string_agg(distinct nullif(t, ''), ', ') tests,
         (array_agg(remarks order by report_date desc) filter (where remarks is not null))[1] remarks
  from lab.reports, lateral unnest(string_to_array(coalesce(tests, ''), ', ')) t
  where report_date >= d0
  group by client_id, pet_id;

  -- VetBuddy bills of those pets since the start date (sale_date index), and every client's latest phone/name
  create temp table _s on commit drop as
  select s.client_id vb_key, s.sale_date, s.sales_unit
  from vetbuddy.sales s
  where s.sale_date >= d0 and s.client_id in (select vb_key from _r);

  -- phone + name: the pet's own latest bill, else the client's latest bill for any pet
  create temp table _c on commit drop as
  select distinct on (r.vb_key) r.vb_key, s.client_name, calldesk.norm_phone(s.client_phone) phone
  from _r r
  join vetbuddy.sales s on split_part(s.client_id, ' ', 1) = r.client_id
  where calldesk.norm_phone(s.client_phone) is not null
  order by r.vb_key, (s.client_id = r.vb_key) desc, s.sale_date desc;

  -- first visit after the LATEST report = came back -> lab.done
  insert into lab.done (vb_key, last_report, unit, pet_name, phone, visit_date, visit_unit, calls_before, closed_on)
  select r.vb_key, r.last_report, r.unit, r.pet_name, coalesce(c.phone, b.phone), v.sale_date, v.sales_unit,
         coalesce(b.calls_before, 0), today
  from _r r
  join lateral (select sale_date, sales_unit from _s where _s.vb_key = r.vb_key and _s.sale_date > r.last_report
                order by sale_date limit 1) v on true
  left join _c c on c.vb_key = r.vb_key
  left join lab.board b on b.vb_key = r.vb_key
  on conflict (vb_key, last_report) do nothing;
  get diagnostics n_closed = row_count;

  delete from lab.board;
  insert into lab.board (vb_key, unit, clinic, client_id, pet_id, pet_name, client_name, phone, first_report, last_report,
                         n_reports, tests, remarks, calls_before, answered_before, last_call_at, last_call_by)
  select r.vb_key, r.unit, r.clinic, r.client_id, r.pet_id, r.pet_name, c.client_name, c.phone, r.first_report,
         r.last_report, r.n_reports, r.tests, r.remarks,
         coalesce(k.n, 0), coalesce(k.ans, 0), k.last_at, k.last_by
  from _r r
  left join _c c on c.vb_key = r.vb_key
  left join lateral (
    select count(*) n, count(*) filter (where answered) ans, max(call_at) last_at,
           (array_agg(replace(coalesce(line, agent), 'Sanchu ', '') order by call_at desc))[1] last_by
    from calldesk.calls k
    where k.phone = c.phone and k.source = 'Runo' and k.direction = 'out'
      and k.call_at >= r.last_report and k.call_at < today) k on true
  where not exists (select 1 from _s where _s.vb_key = r.vb_key and _s.sale_date > r.last_report);
  get diagnostics n_open = row_count;

  return jsonb_build_object('open', n_open, 'came_back', n_closed);
end $$;
revoke all on function lab.refresh() from public, anon, authenticated;

-- What the website reads: the open list + the per-unit counts.
create or replace function public.lf_board() returns jsonb
language plpgsql stable security definer set search_path = lab, calldesk, public as $$
declare
  a calldesk.agents := calldesk.me();
  today date := (now() at time zone 'Asia/Kolkata')::date;
  units text[];
begin
  if a.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  units := case when a.role = 'lead' then null else a.units end;
  return jsonb_build_object(
    'me', jsonb_build_object('name', a.name, 'role', a.role),
    'today', today,
    'vetbuddy_to', (select date_to from vetbuddy.v_data_freshness limit 1),
    'tracker_last', (select max(report_date) from lab.reports),
    'built_at', (select max(built_at) from lab.board),
    'start_date', (select value from lab.settings where key = 'start_date'),
    'rows', coalesce((select jsonb_agg(to_jsonb(b) - 'built_at' order by b.unit, b.last_report desc, b.pet_name)
                      from lab.board b where units is null or b.unit = any (units)), '[]'::jsonb),
    'units', coalesce((select jsonb_agg(u order by u ->> 'unit') from (
        select jsonb_build_object(
          'unit', x.unit,
          'yesterday', count(*) filter (where x.report_date = today - 1),
          'open', (select count(*) from lab.board b where b.unit = x.unit),
          -- came back = VetBuddy visit yesterday (they left the list this morning) / in the last 7 days
          'back_yday', (select count(*) from lab.done d where d.unit = x.unit and d.visit_date = today - 1),
          'back_7d', (select count(*) from lab.done d where d.unit = x.unit and d.visit_date >= today - 7)) u
        from (select unit, report_date from lab.reports where report_date >= today - 1
              union all select unit, null from lab.board
              union all select unit, null from lab.done where visit_date >= today - 7) x
        where x.unit is not null and (units is null or x.unit = any (units))
        group by x.unit) q), '[]'::jsonb));
end $$;
revoke all on function public.lf_board() from public;
grant execute on function public.lf_board() to anon, authenticated;

-- the morning job (GitHub Actions) connects as vb_loader
grant usage on schema lab to vb_loader;
grant select, insert, update, delete on all tables in schema lab to vb_loader;
grant usage on all sequences in schema lab to vb_loader;
grant execute on function lab.refresh(), lab.unit_of(text) to vb_loader;
