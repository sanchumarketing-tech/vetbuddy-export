-- =====================================================================
-- 17  Call Desk  - daily call lists for the backend call-centre team
--
--   calldesk.agents        who works the lists (email = login), their units and daily target
--   calldesk.calls         Corefactor + Runo call logs (loaded every morning by calldesk_load.py)
--   calldesk.reminders     VetBuddy reminders due (yesterday .. +3 days)
--   calldesk.appointments  VetBuddy appointments (2 days back .. tomorrow)
--   calldesk.leads         Corefactor Lead Box (recent days)
--   calldesk.exclusions    numbers never to call (wrong number, DND, deceased ...)
--   calldesk.queue         the daily list: one row per phone number per day, with every reason
--
--   calldesk.build_list(day)   builds the day's list (run 08:05 IST by the GitHub workflow)
--   public.cd_*                the ONLY things the web app can call (security definer;
--                              each agent sees only their own rows; leads see everyone)
--
-- "Called or not" is never typed by people: refresh_status() matches each row's phone number
-- against the Corefactor and Runo logs.
-- Safe to run again (create or replace / if not exists).
-- =====================================================================

create schema if not exists calldesk;

-- ---------------------------------------------------------------- tables
create table if not exists calldesk.agents (
  id           serial primary key,
  email        text not null unique check (email = lower(email)),
  name         text not null,
  role         text not null default 'agent' check (role in ('agent', 'lead')),
  units        text[] not null default '{}',          -- e.g. {ADYAR,NEELANGARAI}; empty = any unit
  daily_target int  not null default 200 check (daily_target between 0 and 1000),
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create table if not exists calldesk.calls (
  source      text not null,                 -- Corefactor | Runo
  call_key    text not null,                 -- md5 of the source row (re-loading the same day is harmless)
  call_at     timestamp not null,            -- IST
  phone       text not null,                 -- last 10 digits
  direction   text,                          -- in | out | ?
  call_type   text,                          -- as in the source
  status      text,                          -- as in the source
  answered    boolean not null default false,
  duration_s  int,
  agent       text,
  loaded_at   timestamptz not null default now(),
  primary key (source, call_key)
);
alter table calldesk.calls add column if not exists customer_name text;   -- name in the call log (Corefactor)
alter table calldesk.calls add column if not exists line text;            -- number / CRM the customer rang
alter table calldesk.calls add column if not exists dtmf text;            -- IVR option pressed
alter table calldesk.calls add column if not exists notes text;
create index if not exists calls_phone_at on calldesk.calls (phone, call_at);
create index if not exists calls_at on calldesk.calls (call_at);

create table if not exists calldesk.reminders (
  due         date not null,
  patient_id  text not null,
  purpose     text not null,
  pet         text,
  client      text,
  phone       text,
  clinic      text,
  species     text,
  loaded_at   timestamptz not null default now(),
  primary key (due, patient_id, purpose)
);

create table if not exists calldesk.appointments (
  appt_id     text primary key,
  appt_date   date,
  appt_time   text,
  created_at  timestamp,
  client      text,
  pet         text,
  phone       text,
  status      text,
  appt_type   text,
  complaint   text,
  clinic      text,
  created_by  text,
  cancel_reason text,
  loaded_at   timestamptz not null default now()
);
create index if not exists appointments_date on calldesk.appointments (appt_date);
create index if not exists appointments_phone on calldesk.appointments (phone);

create table if not exists calldesk.leads (
  lead_key    text primary key,
  created_at  timestamp,
  phone       text,
  name        text,
  purpose     text,
  status      text,
  unit        text,
  raw         jsonb,
  loaded_at   timestamptz not null default now()
);

create table if not exists calldesk.exclusions (
  phone     text primary key,
  reason    text not null,                   -- wrong_number | dnd | deceased | other
  note      text,
  added_by  text,
  added_at  timestamptz not null default now()
);

create table if not exists calldesk.queue (
  id             bigserial primary key,
  list_date      date not null,
  agent_id       int references calldesk.agents (id),
  phone          text not null,
  client         text,
  unit           text,
  rank           int not null,               -- most urgent reason (1 = most urgent)
  score          numeric not null default 0, -- order inside a rank
  reasons        jsonb not null,             -- [{type, rank, label, pet, due}]
  pets           jsonb not null default '[]',-- [{pet_id, name, species, breed, last_visit, ...}]
  tries          int not null default 0,     -- days it was attempted without an answer
  carried_from   date,
  -- from the call logs (refresh_status)
  call_count     int not null default 0,
  attempted_at   timestamp,
  connected_at   timestamp,
  last_call      text,
  -- from the agent
  dialed_at      timestamptz,
  outcome        text check (outcome in ('booked', 'will_visit', 'callback', 'not_interested',
                                         'wrong_number', 'dnd', 'deceased', 'other')),
  note           text,
  callback_at    timestamptz,
  updated_at     timestamptz,
  superseded     boolean not null default false,   -- carried into a later day's list
  unique (list_date, phone)
);
alter table calldesk.queue add column if not exists try_slot text;   -- morning | afternoon | evening: best part of the day to call
alter table calldesk.queue add column if not exists try_note text;
-- holidays for the "holiday boarding" calls (edit / add rows any time)
create table if not exists calldesk.holidays (name text primary key, starts date not null);
insert into calldesk.holidays values ('Christmas and New Year holidays', date '2026-12-24'), ('Pongal holidays', date '2027-01-14'),
  ('Summer holidays', date '2027-05-01'), ('Diwali holidays', date '2027-10-28') on conflict (name) do nothing;
-- bills of the customers on the current lists (refilled by build_list; read by cd_bills - fast, no scan of all sales)
create table if not exists calldesk.bills (phone text not null, sale_date date, invoice_no text, unit text, pet text, item text,
  plan_category text, plan_subcategory text, doctor text, amount numeric);
create index if not exists bills_phone on calldesk.bills (phone);
create index if not exists queue_agent_day on calldesk.queue (agent_id, list_date);
create index if not exists queue_phone on calldesk.queue (phone, list_date);

-- ---------------------------------------------------------------- helpers
create or replace function calldesk.norm_phone(v text) returns text
language sql immutable as $$
  select case when length(regexp_replace(coalesce(v, ''), '\D', '', 'g')) >= 10
              then right(regexp_replace(v, '\D', '', 'g'), 10) end
$$;

create or replace function calldesk.today() returns date
language sql stable as $$ select (now() at time zone 'Asia/Kolkata')::date $$;

create or replace function calldesk.status_of(q calldesk.queue) returns text
language sql immutable as $$
  select case
    when q.outcome in ('booked', 'will_visit', 'not_interested', 'wrong_number', 'dnd', 'deceased') then 'closed'
    when q.outcome = 'callback' and q.connected_at is null then 'callback'
    when q.connected_at is not null then 'connected'
    when q.attempted_at is not null then 'attempted'
    else 'new' end
$$;

-- ---------------------------------------------------------------- called or not (from the logs)
create or replace function calldesk.refresh_status(p_from date default null) returns int
language plpgsql security definer set search_path = calldesk, public as $$
declare n int;
begin
  with c as (
    select q.id,
           count(k.*)                                         as cnt,
           min(k.call_at)                                     as first_at,
           min(k.call_at) filter (where k.answered)           as conn_at,
           (array_agg(k.source || ' ' || to_char(k.call_at, 'DD Mon HH24:MI') || ' ' ||
                      coalesce(nullif(k.status, ''), case when k.answered then 'answered' else 'not answered' end) ||
                      coalesce(' - ' || nullif(k.agent, ''), '') order by k.call_at desc))[1] as last_call
    from calldesk.queue q
    join calldesk.calls k on k.phone = q.phone and k.call_at >= q.list_date::timestamp
                          and coalesce(k.direction, 'out') <> 'in'
    where q.list_date >= coalesce(p_from, calldesk.today() - 14) and not q.superseded
    group by q.id)
  update calldesk.queue q
     set call_count = c.cnt, attempted_at = c.first_at, connected_at = c.conn_at, last_call = c.last_call
    from c where c.id = q.id
      and (q.call_count, q.attempted_at, q.connected_at) is distinct from (c.cnt, c.first_at, c.conn_at);
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------- the daily list
create or replace function calldesk.build_list(p_day date default null, p_rebuild boolean default false)
returns jsonb
language plpgsql security definer set search_path = calldesk, public as $$
declare
  d        date := coalesce(p_day, calldesk.today());
  r        record;
  a        int;
  stats    jsonb;
  capacity int;
  dropped  int := 0;
begin
  perform calldesk.refresh_status(d - 14);

  if p_rebuild then        -- only rows nobody has touched yet are removed
    delete from calldesk.queue where list_date = d and dialed_at is null and outcome is null and note is null;
    update calldesk.queue set superseded = false
     where list_date between d - 7 and d - 1 and superseded
       and not exists (select 1 from calldesk.queue x where x.list_date = d and x.phone = queue.phone);
  elsif exists (select 1 from calldesk.queue where list_date = d) then
    return jsonb_build_object('day', d, 'skipped', 'list already built (use p_rebuild => true)');
  end if;

  -- pets: latest owner, phone, unit per pet (last 15 months of bills) + the per-pet visit summary
  create temp table t_pet on commit drop as
  select distinct on (s.pet_id) s.*, m.first_visit_date, m.client_visit_count, m.first_bathing_visit, m.bathing_visit_count, m.first_haircut_visit, m.haircut_visit_count, m.total_client_revenue,
         m.last_service_name, m.last_bathing_visit, m.last_haircut_visit, m.last_vaccination_visit,
         m.last_consultation_visit
  from (select substring(client_id from '\(([^)]*)\)') pet_id, client_name, calldesk.norm_phone(client_phone) phone,
               patient_name pet_name, species, breed, sales_unit unit, sale_date last_visit
          from vetbuddy.sales
         where client_id is not null and sale_date >= d - 460 and sale_date < d) s
  left join vetbuddy.mv_pbi_pet m on m.pet_id_no = s.pet_id
  where s.phone is not null and s.pet_id is not null
  order by s.pet_id, s.last_visit desc;
  create index on t_pet (pet_id);
  create index on t_pet (phone);

  -- every reason to call today, one row per (phone, reason, pet)
  create temp table t_cand (phone text, client text, unit text, pet_id text, pet text,
                            type text, rank int, label text, due date, score numeric) on commit drop;

  -- 1 missed inbound yesterday (or earlier, up to 3 days) with no call back since

  -- 2 appointment tomorrow: confirm
  insert into t_cand
  select calldesk.norm_phone(ap.phone), ap.client, upper(ap.clinic), null, ap.pet, 'appt_tomorrow', 2,
         'Appointment tomorrow ' || coalesce(substring(ap.appt_time from '\d{1,2}:\d{2}\s*[ap]m'), '') ||
         coalesce(' - ' || nullif(ap.appt_type, ''), '') || ' - confirm', ap.appt_date, 0
  from calldesk.appointments ap
  where ap.appt_date = d + 1 and coalesce(ap.status, '') !~* 'cancel|no.?show'
    and calldesk.norm_phone(ap.phone) is not null;

  -- 3 cancelled / no-show in the last 2 days, not rebooked, no visit since
  insert into t_cand
  select calldesk.norm_phone(ap.phone), ap.client, upper(ap.clinic), null, ap.pet, 'appt_missed', 3,
         case when ap.status ~* 'no.?show' then 'No-show' else 'Cancelled' end || ' appointment on ' ||
         to_char(ap.appt_date, 'DD Mon') || coalesce(' (' || nullif(ap.cancel_reason, '') || ')', '') || ' - rebook',
         ap.appt_date, 0
  from calldesk.appointments ap
  where ap.appt_date between d - 2 and d - 1 and ap.status ~* 'cancel|no.?show'
    and calldesk.norm_phone(ap.phone) is not null
    and not exists (select 1 from calldesk.appointments b where calldesk.norm_phone(b.phone) = calldesk.norm_phone(ap.phone)
                     and b.appt_date >= ap.appt_date and b.appt_id <> ap.appt_id and coalesce(b.status, '') !~* 'cancel|no.?show')
    and not exists (select 1 from t_pet p where p.phone = calldesk.norm_phone(ap.phone) and p.last_visit >= ap.appt_date);

  -- 4 post-surgery review: day 2, and day 7 if no visit since
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'post_surgery', 4,
         'Post-surgery check, day ' || (d - s.sale_date) || ' (surgery ' || to_char(s.sale_date, 'DD Mon') || ')',
         s.sale_date, 0
  from (select distinct substring(client_id from '\(([^)]*)\)') pet_id, sale_date
          from vetbuddy.sales
         where plan_subcategory ilike 'surgery' and sale_date in (d - 2, d - 7)) s
  join t_pet p on p.pet_id = s.pet_id
  where (d - s.sale_date) = 2 or p.last_visit <= s.sale_date;

  -- 5 VetBuddy reminders due yesterday .. tomorrow with no call (in or out) from due - 3 days
  insert into t_cand
  select coalesce(calldesk.norm_phone(rm.phone), p.phone), coalesce(nullif(rm.client, ''), p.client_name),
         coalesce(p.unit, upper(rm.clinic)), rm.patient_id, rm.pet,
         case when rm.purpose ~* 'vaccin|booster|rabies|dhpp|tri ?cat|arv|lepto|kennel|corona' then 'vaccine_due'
              when rm.purpose ~* 'review|follow' then 'review_due'
              when rm.purpose ~* 'hair ?cut|trim|styl' then 'haircut_due'
              when rm.purpose ~* 'bath|groom|spa|nail|hygien' then 'bath_due'
              when rm.purpose ~* 'report' then 'report_ready'
              else 'reminder' end,
         case when rm.purpose ~* 'hair ?cut|trim|styl' then 8 when rm.purpose ~* 'bath|groom|spa|nail|hygien' then 7 else 5 end,
         case when rm.purpose ~* 'vaccin|booster|rabies|dhpp|tri ?cat|arv|lepto|kennel|corona' then 'Vaccine due '
              when rm.purpose ~* 'review|follow' then 'Review due '
              when rm.purpose ~* 'hair ?cut|trim|styl' then 'Haircut due '
              when rm.purpose ~* 'bath|groom|spa|nail|hygien' then 'Bath due '
              when rm.purpose ~* 'report' then 'Report ready to collect '
              else 'Reminder due ' end || to_char(rm.due, 'DD Mon') || ': ' || rm.purpose,
         rm.due, -(rm.due - d)
  from calldesk.reminders rm
  left join t_pet p on p.pet_id = rm.patient_id
  where rm.due between d - 1 and d + 1
    and coalesce(calldesk.norm_phone(rm.phone), p.phone) is not null
    and not exists (select 1 from calldesk.calls k where k.phone = coalesce(calldesk.norm_phone(rm.phone), p.phone)
                     and k.call_at >= (rm.due - 3)::timestamp);

  -- 7 bathing due (30-45 days since the last bath, no visit since)
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'bath_due', 7,
         'Bath due - last bath ' || to_char(p.last_bathing_visit, 'DD Mon') || case when coalesce(p.bathing_visit_count, 0) >= 3 then ' (regular: ' || p.bathing_visit_count || ' baths, usually every ' || greatest(20, least(90, (p.last_bathing_visit - p.first_bathing_visit) / (p.bathing_visit_count - 1))) || ' days)' else '' end, p.last_bathing_visit + 30,
         d - p.last_bathing_visit
  from t_pet p
  where p.last_visit <= p.last_bathing_visit and ((coalesce(p.bathing_visit_count, 0) >= 3 and (d - p.last_bathing_visit) between greatest(20, least(90, (p.last_bathing_visit - p.first_bathing_visit) / (p.bathing_visit_count - 1))) and 1.6 * greatest(20, least(90, (p.last_bathing_visit - p.first_bathing_visit) / (p.bathing_visit_count - 1)))) or (coalesce(p.bathing_visit_count, 0) < 3 and p.last_bathing_visit between d - 45 and d - 30));

  -- 8 haircut due (45-60 days since the last haircut, no visit since)
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'haircut_due', 8,
         'Haircut due - last haircut ' || to_char(p.last_haircut_visit, 'DD Mon') || case when coalesce(p.haircut_visit_count, 0) >= 3 then ' (regular: ' || p.haircut_visit_count || ' haircuts, usually every ' || greatest(30, least(120, (p.last_haircut_visit - p.first_haircut_visit) / (p.haircut_visit_count - 1))) || ' days)' else '' end, p.last_haircut_visit + 45,
         d - p.last_haircut_visit
  from t_pet p
  where p.last_visit <= p.last_haircut_visit and ((coalesce(p.haircut_visit_count, 0) >= 3 and (d - p.last_haircut_visit) between greatest(30, least(120, (p.last_haircut_visit - p.first_haircut_visit) / (p.haircut_visit_count - 1))) and 1.6 * greatest(30, least(120, (p.last_haircut_visit - p.first_haircut_visit) / (p.haircut_visit_count - 1)))) or (coalesce(p.haircut_visit_count, 0) < 3 and p.last_haircut_visit between d - 60 and d - 45));

  -- 9 consultation follow-up (7-9 days after a consultation, no visit since)
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'consult_followup', 9,
         'Follow-up after consultation on ' || to_char(p.last_consultation_visit, 'DD Mon'),
         p.last_consultation_visit + 7, 0
  from t_pet p
  where p.last_consultation_visit between d - 9 and d - 7 and p.last_visit <= p.last_consultation_visit;

  -- 10 new pet welcome (first visit in the last 3 days)

  -- 11 Lead Box enquiries from the last 2 days that are still open
  insert into t_cand
  select calldesk.norm_phone(l.phone), l.name, upper(l.unit), null, null, 'lead', 11,
         'Enquiry' || coalesce(': ' || nullif(l.purpose, ''), '') || ' (' || to_char(l.created_at, 'DD Mon') || ')',
         l.created_at::date, 0
  from calldesk.leads l
  where l.created_at >= (d - 2)::timestamp and l.created_at < d::timestamp
    and coalesce(l.status, '') !~* 'book|convert|closed|visited|done'
    and calldesk.norm_phone(l.phone) is not null;

  -- 12 churned regulars (2+ visit days, last visit 60-90 days ago): fills the lists, best customers first

  -- ---- exclusions
  -- one reason per pet: a VetBuddy reminder and the bills-based rule for the same pet and service count once
  -- (the reminder, inserted first, is kept - it names the exact item)
  -- ---- extra reasons from the bills (13 Nov 2026): per-pet facts in one pass
  create temp table t_ext on commit drop as
  select z.pet_id,
         max(case when z.patient_dob_text ~ '^[A-Z][a-z]{2}, \d{2} \d{4}$' then to_date(z.patient_dob_text, 'Mon, DD YYYY') end) as dob,
         max(z.sale_date) filter (where z.item_name ~* 'deworming' and z.item_name !~* 'advice') as last_deworm,
         max(z.sale_date) filter (where z.item_name ~* 'tick' and z.plan_category ilike 'laborator%') as last_tick,
         max(z.sale_date) filter (where z.plan_category ilike 'laborator%' or z.plan_subcategory ilike 'health check%') as last_lab,
         (array_agg(z.item_name order by z.sale_date desc) filter (where z.plan_category ilike 'vaccination%' and z.item_name ilike 'Vaccination &%'))[1] as last_vac_item,
         max(z.sale_date) filter (where z.plan_category ilike 'vaccination%' and z.item_name ilike 'Vaccination &%') as last_vac,
         count(distinct z.sale_date) filter (where z.item_name ~* 'post bite' and z.sale_date >= d - 35) as pb_n,
         max(z.sale_date) filter (where z.plan_subcategory ilike 'holiday boarding') as last_board
  from (select substring(client_id from '\(([^)]*)\)') as pet_id, patient_dob_text, sale_date, item_name, plan_category, plan_subcategory
          from vetbuddy.sales where client_id is not null and sale_date >= d - 460 and sale_date < d) z
  group by z.pet_id;
  create index on t_ext (pet_id);
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'rabies_course', 4,
         'Anti-rabies (post bite) course: ' || e.pb_n || ' of 5 doses given, last on ' || to_char(e.last_vac, 'DD Mon') || ' - next dose is due',
         e.last_vac, d - e.last_vac
  from t_pet p join t_ext e using (pet_id)
  where e.last_vac_item ~* 'post bite' and d - e.last_vac between 7 and 28 and e.pb_n < 5;
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'vaccine_course', 5,
         'Vaccine course not finished: ' || regexp_replace(e.last_vac_item, '^Vaccination & Physical Examination - ', '') || ' given on ' || to_char(e.last_vac, 'DD Mon') || ' - next dose is due',
         e.last_vac + 21, d - e.last_vac
  from t_pet p join t_ext e using (pet_id)
  where e.last_vac_item ~* 'primary|1st booster|2nd booster' and e.last_vac_item !~* 'annual' and d - e.last_vac between 21 and 60;
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'deworm_due', 6,
         'Deworming due - last done on ' || to_char(e.last_deworm, 'DD Mon') || ' (every 3 months)', e.last_deworm + 90, d - e.last_deworm
  from t_pet p join t_ext e using (pet_id)
  where d - e.last_deworm between 85 and 120;
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'tick_recheck', 6,
         'Tick fever test on ' || to_char(e.last_tick, 'DD Mon') || ', no visit since - ask how the pet is, offer review / re-test', e.last_tick, d - e.last_tick
  from t_pet p join t_ext e using (pet_id)
  where d - e.last_tick between 10 and 30 and p.last_visit <= e.last_tick;
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'sibling_vaccine', 9,
         'Vaccination check: no vaccine with us in the last year, but ' || sb.pet_name || ' (same owner) was vaccinated on ' || to_char(sb.last_vaccination_visit, 'DD Mon'),
         sb.last_vaccination_visit, coalesce(p.total_client_revenue, 0)
  from t_pet p
  join lateral (select o.pet_name, o.last_vaccination_visit from t_pet o where o.phone = p.phone and o.pet_id <> p.pet_id
                 and o.last_vaccination_visit >= d - 90 order by o.last_vaccination_visit desc limit 1) sb on true
  where p.last_vaccination_visit is null and p.last_visit >= d - 180;
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'birthday', 10,
         'Birthday on ' || to_char(e.dob, 'DD Mon') || ' (turning ' || (extract(year from d)::int - extract(year from e.dob)::int) || ') - wish them, offer a birthday groom / health check',
         d, coalesce(p.total_client_revenue, 0)
  from t_pet p join t_ext e using (pet_id)
  where e.dob is not null and p.last_visit >= d - 180 and extract(year from e.dob) < extract(year from d)
    and to_char(e.dob, 'MMDD') between to_char(d, 'MMDD') and to_char(d + 3, 'MMDD');
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'senior_check', 11,
         'Senior pet (' || ((d - e.dob) / 365) || ' yrs): ' || case when e.last_lab is null then 'no health check or lab test in the last year' else 'last health check / lab on ' || to_char(e.last_lab, 'DD Mon') end || ' - offer a senior check-up',
         d, coalesce(p.total_client_revenue, 0)
  from t_pet p join t_ext e using (pet_id)
  where e.dob <= d - 2555 and p.last_visit between d - 365 and d - 30 and (e.last_lab is null or e.last_lab < d - 180);
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'vaccine_never', 11,
         'Grooming regular (' || p.bathing_visit_count || ' baths), no vaccination with us in the last year - check vaccine and deworming status',
         d, coalesce(p.total_client_revenue, 0)
  from t_pet p
  where coalesce(p.bathing_visit_count, 0) >= 2 and p.last_bathing_visit >= d - 120 and p.last_vaccination_visit is null;
  -- past holiday boarders, 21 to 7 days before each holiday in calldesk.holidays
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'boarding_holiday', 10,
         h.name || ' from ' || to_char(h.starts, 'DD Mon') || ' - boarded with us on ' || to_char(e.last_board, 'DD Mon YYYY') || ' - offer to book boarding early',
         h.starts, coalesce(p.total_client_revenue, 0)
  from t_pet p join t_ext e using (pet_id)
  join calldesk.holidays h on d between h.starts - 21 and h.starts - 7
  where e.last_board is not null;
  delete from t_cand a using t_cand b where a.type = 'vaccine_course' and b.type = 'vaccine_due' and a.phone = b.phone and lower(coalesce(a.pet, '')) = lower(coalesce(b.pet, ''));
  delete from t_cand a using t_cand b where a.type = 'vaccine_never' and b.type = 'sibling_vaccine' and a.phone = b.phone and a.pet_id = b.pet_id;
  delete from t_cand a using t_cand b
   where a.phone = b.phone and a.type = b.type and a.ctid > b.ctid
     and lower(coalesce(a.pet_id, a.pet, '')) in (lower(coalesce(b.pet_id, b.pet, '')), lower(coalesce(b.pet, '')));
  delete from t_cand c where c.phone is null or c.phone !~ '^[6-9]\d{9}$'
     or exists (select 1 from calldesk.exclusions x where x.phone = c.phone);
  -- non-urgent reasons: skip numbers that were in touch (any call, in or out) in the last 3 days
  delete from t_cand c where c.rank >= 7
     and exists (select 1 from calldesk.calls k where k.phone = c.phone and k.call_at >= (d - 3)::timestamp);
  -- the same reason was already answered / closed in the last 30 days, or tried 3 times
  delete from t_cand c where exists (
     select 1 from calldesk.queue q
      where q.phone = c.phone and q.list_date between d - 30 and d - 1
        and q.reasons @> jsonb_build_array(jsonb_build_object('type', c.type))
        and (q.connected_at is not null or q.outcome is not null or q.tries >= 3));

  -- ---- carry over: earlier rows not answered and not closed (up to 3 tries, 7 days) + call-backs due today
  create temp table t_carry on commit drop as
  select q.* from calldesk.queue q
  where q.list_date between d - 7 and d - 1 and not q.superseded
    and ((q.connected_at is null and q.outcome is null and q.tries + (q.attempted_at is not null)::int < 3)
         or (q.outcome = 'callback' and (q.callback_at at time zone 'Asia/Kolkata')::date <= d))
    and not exists (select 1 from calldesk.exclusions x where x.phone = q.phone);

  insert into calldesk.queue (list_date, agent_id, phone, client, unit, rank, score, reasons, pets, tries, carried_from)
  select d, c.agent_id, c.phone, c.client, c.unit,
         case when c.outcome = 'callback' then 0 else c.rank end, c.score,
         case when c.outcome = 'callback'
              then jsonb_build_array(jsonb_build_object('type', 'callback', 'rank', 0,
                     'label', 'Call back as promised' || coalesce(' at ' || to_char(c.callback_at at time zone 'Asia/Kolkata', 'HH12:MI am'), '')
                              || coalesce(' - ' || c.note, ''))) || c.reasons
              else c.reasons end,
         c.pets, c.tries + (c.attempted_at is not null)::int, coalesce(c.carried_from, c.list_date)
  from (select distinct on (phone) * from t_carry order by phone, list_date desc) c
  on conflict (list_date, phone) do nothing;
  update calldesk.queue q set superseded = true from t_carry c where q.id = c.id;
  delete from t_cand c where exists (select 1 from calldesk.queue q where q.list_date = d and q.phone = c.phone);

  -- ---- one row per phone number, every reason on it, ranked
  create temp table t_row on commit drop as
  select c.phone,
         (array_agg(c.type order by c.rank, c.score desc))[1] as top_type,
         (array_agg(c.client order by c.rank) filter (where c.client is not null))[1] as client,
         (array_agg(c.unit order by c.rank) filter (where c.unit is not null))[1] as unit,
         min(c.rank) as rank,
         max(c.score) filter (where c.rank = c.top) as score,
         jsonb_agg(distinct jsonb_strip_nulls(jsonb_build_object('type', c.type, 'rank', c.rank, 'label', c.label,
                                                                 'pet', c.pet, 'due', c.due))) as reasons
  from (select t_cand.*, min(rank) over (partition by phone) as top from t_cand) c
  group by c.phone;

  -- pets on each number (up to 6, most recent first)
  create temp table t_rowpets on commit drop as
  select tr.phone, coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'pet_id', p.pet_id, 'name', p.pet_name, 'species', p.species, 'breed', p.breed, 'unit', p.unit,
           'last_visit', p.last_visit, 'first_visit', p.first_visit_date, 'visits', p.client_visit_count,
           'revenue', round(p.total_client_revenue), 'last_service', p.last_service_name,
           'last_vaccination', p.last_vaccination_visit, 'last_bath', p.last_bathing_visit,
           'last_haircut', p.last_haircut_visit, 'last_consultation', p.last_consultation_visit))
           order by p.last_visit desc) filter (where p.pet_id is not null), '[]') as pets
  from t_row tr
  left join lateral (select * from t_pet where t_pet.phone = tr.phone order by last_visit desc limit 6) p on true
  group by tr.phone;

  -- ---- allocation: each agent up to their target, own units first, most urgent first
  create temp table t_agent on commit drop as
  select ag.id, ag.units, ag.daily_target as target,
         (select count(*) from calldesk.queue q where q.list_date = d and q.agent_id = ag.id)::int as n
  from calldesk.agents ag where ag.active and ag.role = 'agent' and ag.daily_target > 0;
  select coalesce(sum(target), 0) into capacity from t_agent;

  -- share of a 200 list per reason (rows of a reason are spread evenly through the list)
  for r in select t.*, rp.pets from t_row t join t_rowpets rp using (phone)
           order by (t.rank = 12), row_number() over (partition by t.top_type order by t.score desc nulls last, t.phone)::numeric
                    / case t.top_type when 'missed_call' then 40 when 'appt_tomorrow' then 35 when 'appt_missed' then 20
                                      when 'post_surgery' then 15 when 'vaccine_due' then 40 when 'review_due' then 20
                                      when 'report_ready' then 5 when 'reminder' then 5 when 'grooming_due' then 10
                                      when 'bath_due' then 12 when 'haircut_due' then 8 when 'consult_followup' then 15
                                      when 'new_pet' then 10 when 'rabies_course' then 10 when 'vaccine_course' then 30 when 'deworm_due' then 10 when 'tick_recheck' then 8 when 'sibling_vaccine' then 10 when 'birthday' then 10 when 'senior_check' then 10 when 'vaccine_never' then 10 when 'boarding_holiday' then 15 when 'lead' then 10 else 1 end,
                    t.rank, t.phone loop
    a := null;
    if capacity > 0 then
      select id into a from t_agent where n < target and (units = '{}' or r.unit = any (units))
       order by (units = '{}'), n::numeric / target, id limit 1;
      if a is null then
        select id into a from t_agent where n < target order by n::numeric / target, id limit 1;
      end if;
      if a is null then
        if r.rank < 12 then dropped := dropped + 1; end if;
        continue;
      end if;
      update t_agent set n = n + 1 where id = a;
    elsif r.rank = 12 then
      continue;                     -- no agents set up yet: list the must-call rows only (unassigned)
    end if;
    insert into calldesk.queue (list_date, agent_id, phone, client, unit, rank, score, reasons, pets)
    values (d, a, r.phone, r.client, r.unit, r.rank, coalesce(r.score, 0), r.reasons, r.pets)
    on conflict (list_date, phone) do nothing;
  end loop;

  -- carried rows with no agent (or an agent who is no longer active) get one now
  for r in select q.id, q.unit from calldesk.queue q
           where q.list_date = d and (q.agent_id is null or q.agent_id not in (select id from t_agent)) loop
    select id into a from t_agent where (units = '{}' or r.unit = any (units)) order by n::numeric / target, id limit 1;
    if a is null then select id into a from t_agent order by n::numeric / target, id limit 1; end if;
    exit when a is null;
    update calldesk.queue set agent_id = a where id = r.id;
    update t_agent set n = n + 1 where id = a;
  end loop;

  -- best time of day to call each number, from the last 30 days of call logs:
  -- the part of the day it answered before, else a part of the day not tried yet
  delete from calldesk.bills;
  insert into calldesk.bills
  select x.phone, x.sale_date, x.invoice_no, x.sales_unit, x.patient_name, x.item_name, x.plan_category, x.plan_subcategory, x.doctor, round(x.amount)
  from (select calldesk.norm_phone(s2.client_phone) as phone, s2.* from vetbuddy.sales s2 where s2.sale_date >= d - 400) x
  where x.phone in (select q3.phone from calldesk.queue q3 where q3.list_date >= d - 1);
  update calldesk.queue q set try_slot = h.slot, try_note = h.note
  from (select x.phone,
               coalesce(x.ans_slot, case when not x.f_m then 'morning' when not x.f_e then 'evening' when not x.f_a then 'afternoon' else 'evening' end) as slot,
               case when x.ans_slot is not null then 'Answered before in the ' || x.ans_slot
                    else 'Not answered ' || x.fails || case when x.fails = 1 then ' time' else ' times' end || ' (' || x.failed || ') - try the ' ||
                         case when not x.f_m then 'morning' when not x.f_e then 'evening' when not x.f_a then 'afternoon' else 'evening' end end as note
        from (select k.phone,
                     mode() within group (order by k.slot) filter (where k.answered) as ans_slot,
                     count(*) filter (where not k.answered and k.direction <> 'in') as fails,
                     string_agg(distinct k.slot, ', ') filter (where not k.answered and k.direction <> 'in') as failed,
                     coalesce(bool_or(k.slot = 'morning') filter (where not k.answered and k.direction <> 'in'), false) as f_m,
                     coalesce(bool_or(k.slot = 'afternoon') filter (where not k.answered and k.direction <> 'in'), false) as f_a,
                     coalesce(bool_or(k.slot = 'evening') filter (where not k.answered and k.direction <> 'in'), false) as f_e
              from (select phone, answered, coalesce(direction, '?') as direction,
                           case when extract(hour from call_at) < 12 then 'morning' when extract(hour from call_at) < 16 then 'afternoon' else 'evening' end as slot
                      from calldesk.calls where call_at >= (d - 30)::timestamp) k
              group by k.phone) x
        where x.ans_slot is not null or x.fails > 0) h
  where q.list_date = d and q.phone = h.phone;
  select jsonb_build_object('day', d, 'agents', (select count(*) from t_agent), 'capacity', capacity,
           'rows', count(*), 'carried', count(*) filter (where carried_from is not null),
           'must_call_not_fitted', dropped,
           'by_reason', (select jsonb_object_agg(t, n) from (
               select e->>'type' t, count(*) n from calldesk.queue q2, jsonb_array_elements(q2.reasons) e
                where q2.list_date = d group by 1) z))
    into stats from calldesk.queue where list_date = d;
  return stats;
end $$;

-- ---------------------------------------------------------------- the web app's functions
-- No sign-in (decided 13 Nov 2026): everyone opening the Call Desk acts as the team lead;
-- a signed-in email (if sign-in is added back) still maps to its own row.
create or replace function calldesk.me() returns calldesk.agents
language sql stable security definer set search_path = calldesk, public as $$
  select a from calldesk.agents a
  where a.active and (a.email = lower(coalesce(auth.jwt() ->> 'email', '')) or a.role = 'lead')
  order by (a.email = lower(coalesce(auth.jwt() ->> 'email', ''))) desc, a.id
  limit 1
$$;

create or replace function public.cd_me() returns jsonb
language sql stable security definer set search_path = calldesk, public as $$
  select case when m.id is null then null
         else jsonb_build_object('id', m.id, 'name', m.name, 'email', m.email, 'role', m.role, 'units', m.units,
                                 'target', m.daily_target, 'today', calldesk.today()) end
  from calldesk.me() m
$$;

-- an agent's list (a lead may pass any agent, or 0 = unassigned rows, or null = everyone)
create or replace function public.cd_list(p_day date default null, p_agent int default -1) returns jsonb
language plpgsql stable security definer set search_path = calldesk, public as $$
declare m calldesk.agents := calldesk.me(); who int;
begin
  if m.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  who := case when m.role = 'lead' then nullif(p_agent, -1) else m.id end;
  if m.role = 'lead' and p_agent = -1 then who := null; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', q.id, 'day', q.list_date, 'agent_id', q.agent_id, 'phone', q.phone, 'client', q.client, 'unit', q.unit,
             'rank', q.rank, 'reasons', q.reasons, 'pets', q.pets, 'tries', q.tries, 'carried_from', q.carried_from,
             'calls', q.call_count, 'attempted_at', q.attempted_at, 'connected_at', q.connected_at, 'last_call', q.last_call,
             'dialed_at', q.dialed_at, 'outcome', q.outcome, 'note', q.note, 'callback_at', q.callback_at,
             'status', calldesk.status_of(q), 'try_slot', q.try_slot, 'try_note', q.try_note)
           order by q.rank, q.score desc, q.id)
    from calldesk.queue q
    where q.list_date = coalesce(p_day, calldesk.today())
      and (who is null and m.role = 'lead' or q.agent_id = who or (who = 0 and q.agent_id is null))), '[]');
end $$;

-- the call history of a number on someone's list
create or replace function public.cd_calls(p_phone text) returns jsonb
language plpgsql stable security definer set search_path = calldesk, public as $$
declare m calldesk.agents := calldesk.me();
begin
  if m.id is null or (m.role <> 'lead' and not exists (
       select 1 from calldesk.queue q where q.phone = p_phone and q.agent_id = m.id and q.list_date >= calldesk.today() - 30))
  then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x order by x.call_at desc) from (
    select k.call_at, k.source, k.direction, k.status, k.answered, k.duration_s, k.agent
      from calldesk.calls k where k.phone = p_phone order by k.call_at desc limit 15) x), '[]');
end $$;

-- VetBuddy summary: the latest bill lines of the pets on a number that is on a list
create or replace function public.cd_bills(p_phone text) returns jsonb
language plpgsql stable security definer set search_path = calldesk, public as $$
declare m calldesk.agents := calldesk.me();
begin
  if m.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x order by x.sale_date desc, x.invoice_no) from (
    select b.sale_date, b.invoice_no, b.unit, b.pet, b.item, b.plan_category, b.plan_subcategory, b.doctor, b.amount
      from calldesk.bills b where b.phone = p_phone order by b.sale_date desc, b.invoice_no limit 40) x), '[]');
end $$;

-- the agent clicked "Call" (only shown in the app; "called or not" still comes from the logs)
create or replace function public.cd_dial(p_id bigint) returns void
language plpgsql security definer set search_path = calldesk, public as $$
declare m calldesk.agents := calldesk.me();
begin
  update calldesk.queue set dialed_at = now(), updated_at = now()
   where id = p_id and (agent_id = m.id or m.role = 'lead');
  if not found then raise exception 'not allowed' using errcode = '42501'; end if;
end $$;

-- the agent's outcome / note / call-back time
create or replace function public.cd_save(p_id bigint, p_outcome text, p_note text default null,
                                          p_callback timestamptz default null) returns void
language plpgsql security definer set search_path = calldesk, public as $$
declare m calldesk.agents := calldesk.me(); q calldesk.queue;
begin
  select * into q from calldesk.queue where id = p_id and (agent_id = m.id or m.role = 'lead');
  if q.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_outcome = 'callback' and p_callback is null then raise exception 'pick a call-back time'; end if;
  update calldesk.queue set outcome = nullif(p_outcome, ''), note = nullif(trim(p_note), ''),
         callback_at = case when p_outcome = 'callback' then p_callback end, updated_at = now()
   where id = p_id;
  if p_outcome in ('wrong_number', 'dnd', 'deceased') then
    insert into calldesk.exclusions (phone, reason, note, added_by)
    values (q.phone, p_outcome, nullif(trim(p_note), ''), m.email)
    on conflict (phone) do update set reason = excluded.reason, note = excluded.note,
                                      added_by = excluded.added_by, added_at = now();
  end if;
end $$;

-- team lead: progress per agent for a day
create or replace function public.cd_team(p_day date default null) returns jsonb
language plpgsql stable security definer set search_path = calldesk, public as $$
declare m calldesk.agents := calldesk.me(); d date := coalesce(p_day, calldesk.today());
begin
  if m.role is distinct from 'lead' then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object('day', d, 'agents', coalesce((
    select jsonb_agg(x order by x.name) from (
      select a.id, a.name, a.email, a.role, a.units, a.daily_target target, a.active,
             count(q.id) assigned,
             count(q.id) filter (where q.attempted_at is not null) attempted,
             count(q.id) filter (where q.connected_at is not null) connected,
             count(q.id) filter (where q.outcome = 'booked') booked,
             count(q.id) filter (where q.outcome = 'callback') callbacks,
             count(q.id) filter (where q.dialed_at is not null) dialed,
             count(q.id) filter (where q.rank < 12) must_call
        from calldesk.agents a
        left join calldesk.queue q on q.agent_id = a.id and q.list_date = d
       group by a.id) x), '[]'),
    'unassigned', (select count(*) from calldesk.queue where list_date = d and agent_id is null),
    'by_reason', (select coalesce(jsonb_agg(z order by z.rank), '[]') from (
        select e->>'type' type, min((e->>'rank')::int) rank, count(*) due,
               count(*) filter (where q.attempted_at is not null) attempted,
               count(*) filter (where q.connected_at is not null) connected
          from calldesk.queue q, jsonb_array_elements(q.reasons) e
         where q.list_date = d group by 1) z),
    'last_call_loaded', (select max(call_at) from calldesk.calls));
end $$;

-- team lead: add / change an agent
create or replace function public.cd_agent_save(p_email text, p_name text, p_role text default 'agent',
    p_units text[] default '{}', p_target int default 200, p_active boolean default true) returns void
language plpgsql security definer set search_path = calldesk, public as $$
declare m calldesk.agents := calldesk.me();
begin
  if m.role is distinct from 'lead' then raise exception 'not allowed' using errcode = '42501'; end if;
  if lower(trim(p_email)) = m.email and (p_role <> 'lead' or not p_active) then
    raise exception 'you cannot remove your own lead access';
  end if;
  insert into calldesk.agents (email, name, role, units, daily_target, active)
  values (lower(trim(p_email)), trim(p_name), p_role, coalesce(p_units, '{}'), p_target, p_active)
  on conflict (email) do update set name = excluded.name, role = excluded.role, units = excluded.units,
                                    daily_target = excluded.daily_target, active = excluded.active;
end $$;

-- team lead: move rows to another agent
create or replace function public.cd_assign(p_ids bigint[], p_agent int) returns int
language plpgsql security definer set search_path = calldesk, public as $$
declare m calldesk.agents := calldesk.me(); n int;
begin
  if m.role is distinct from 'lead' then raise exception 'not allowed' using errcode = '42501'; end if;
  update calldesk.queue set agent_id = p_agent, updated_at = now() where id = any (p_ids);
  get diagnostics n = row_count;
  return n;
end $$;

-- KPIs: due -> attempted -> connected -> converted (a bill for that number within the window)
create or replace function public.cd_kpi(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = calldesk, public as $$
declare m calldesk.agents := calldesk.me();
begin
  if m.role is distinct from 'lead' then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((
    with r as (
      select q.id, q.phone, q.list_date, q.attempted_at, q.connected_at, e->>'type' as type, (e->>'rank')::int as rank,
             q.list_date + case e->>'type' when 'churned' then 30 when 'new_pet' then 60 when 'appt_tomorrow' then 1
                                          when 'post_surgery' then 10 else 14 end as until
        from calldesk.queue q, jsonb_array_elements(q.reasons) e
       where q.list_date between p_from and p_to and not q.superseded),
    s as materialized (
      select calldesk.norm_phone(client_phone) phone, sale_date, plan_category, plan_subcategory
        from vetbuddy.sales where sale_date between p_from and p_to + 60),
    conv as (
      select distinct r.id, r.type from r join s on s.phone = r.phone and s.sale_date between r.list_date and r.until
       where (r.type <> 'reminder' or s.plan_category ilike 'vaccination%' or s.plan_subcategory ilike any (array['%consult%', '%review%']))
         and (r.type <> 'bath_due' or s.plan_subcategory ilike 'bathing')
         and (r.type <> 'haircut_due' or s.plan_subcategory ilike 'haircut')
         and (r.type <> 'post_surgery' or s.plan_subcategory ilike any (array['%consult%', '%review%'])))
    select jsonb_agg(z order by z.rank) from (
      select r.type, min(r.rank) rank, count(*) due,
             count(*) filter (where r.attempted_at is not null) attempted,
             count(*) filter (where r.connected_at is not null) connected,
             count(c.id) converted,
             count(c.id) filter (where r.connected_at is not null) converted_after_call
        from r left join conv c on c.id = r.id and c.type = r.type
       group by r.type) z), '[]');
end $$;

-- ---------------------------------------------------------------- rights
-- the web app (signed-in users) can only run the cd_* functions; the tables stay private
revoke all on all tables in schema calldesk from public, anon, authenticated;
revoke all on schema calldesk from public, anon, authenticated;
revoke execute on function public.cd_me(), public.cd_list(date, int), public.cd_calls(text), public.cd_dial(bigint),
  public.cd_save(bigint, text, text, timestamptz), public.cd_team(date),
  public.cd_agent_save(text, text, text, text[], int, boolean), public.cd_assign(bigint[], int),
  public.cd_kpi(date, date), public.cd_bills(text) from public, anon;
grant execute on function public.cd_me(), public.cd_list(date, int), public.cd_calls(text), public.cd_dial(bigint),
  public.cd_save(bigint, text, text, timestamptz), public.cd_team(date),
  public.cd_agent_save(text, text, text, text[], int, boolean), public.cd_assign(bigint[], int),
  public.cd_kpi(date, date), public.cd_bills(text) to authenticated, anon;   -- anon: no sign-in (see calldesk.me)

-- the daily loader (vb_loader): fill the source tables and build the list
grant usage on schema calldesk to vb_loader;
grant select, insert, update, delete on calldesk.calls, calldesk.reminders, calldesk.appointments, calldesk.leads
  to vb_loader;
grant select on calldesk.queue, calldesk.agents to vb_loader;
grant execute on function calldesk.build_list(date, boolean), calldesk.refresh_status(date), calldesk.today(),
  calldesk.norm_phone(text) to vb_loader;
