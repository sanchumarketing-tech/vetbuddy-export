-- 23 Nov 2026: deceased pets are never called about (strict).
--
-- calldesk.deceased_pets  every pet VetBuddy marks Deceased (all dates). Replaced in full every morning by
--                         vetbuddy_deceased_export.py (.github/workflows/deceased-daily.yml), then
--                         calldesk.deceased_apply() runs.
-- calldesk.deceased_map   phone + pet id + pet name of each deceased pet (from vetbuddy.sales, the old summary
--                         and the appointments), and all_dead = the number has no living pet that we know of.
--
-- The rule, everywhere:
--   * a reason or pet card about a deceased pet is removed (matched by pet id, or by pet name on that number)
--   * a number whose pets are all deceased is not called at all (not even a call-back)
-- Where it is applied:
--   build_list      deceased pets leave t_pet (no reasons, no pet cards); candidates about them are deleted;
--                   carried rows and follow-ups are cleaned (deceased_clean) before the lists are filled
--   visible_ids     (the gate of cd_list / KPIs) a row shows only if a reason is left after the deceased strip
--   cd_list         the agent never sees the deceased pet's reasons or card
--   deceased_apply  after each morning load: today's and later untouched rows and the follow-ups are cleaned
-- Run as the admin (postgres) in the SQL editor. build_list is patched from its live text (see the end).

create table if not exists calldesk.deceased_pets (
  pet_id       text primary key,
  pet_name     text,
  client_name  text,
  first_active text,
  last_active  date,
  loaded_at    timestamptz not null default now()
);
create table if not exists calldesk.deceased_map (
  phone    text not null,
  pet_id   text,
  pet_lc   text,
  all_dead boolean not null default false
);
create index if not exists deceased_map_phone on calldesk.deceased_map (phone);
revoke all on calldesk.deceased_pets, calldesk.deceased_map from public, anon, authenticated;
grant select, insert, delete on calldesk.deceased_pets to vb_loader;
grant select on calldesk.deceased_map to vb_loader;

-- one reason or pet card about a deceased pet?  Reasons carry "pet" as a name, several names ("A, B, C" for
-- key customers) or "Name (12345) &nbsp" (appointments); pet cards carry "pet_id". Strict: one deceased pet
-- in the list is enough (a key-customer call naming the deceased pet is not made).
create or replace function calldesk.deceased_hit(p_phone text, e jsonb)
 returns boolean language sql stable security definer set search_path to 'calldesk', 'public' as $$
  select exists (select 1 from calldesk.deceased_map m where m.phone = p_phone and m.all_dead)
      or (e ? 'pet_id' and exists (select 1 from calldesk.deceased_pets x where x.pet_id = e->>'pet_id'))
      or (not e ? 'pet_id' and coalesce(e->>'pet', e->>'name', '') <> '' and exists (
            select 1 from regexp_split_to_table(coalesce(e->>'pet', e->>'name'), '\s*,\s*') t(tok)
             where exists (select 1 from calldesk.deceased_pets x where x.pet_id = substring(t.tok from '\((\d+)\)'))
                or exists (select 1 from calldesk.deceased_map m where m.phone = p_phone
                              and m.pet_lc = lower(trim(regexp_replace(t.tok, '\s*\(\d+\).*$', ''))))))
$$;

-- reasons or pets without the deceased ones; [] when the number is all deceased
create or replace function calldesk.deceased_strip(p_phone text, p jsonb)
 returns jsonb language sql stable security definer set search_path to 'calldesk', 'public' as $$
  select case when not exists (select 1 from calldesk.deceased_map m where m.phone = p_phone) then coalesce(p, '[]'::jsonb)
              -- (fast path: every billed deceased pet is in the map under its number)
         else coalesce((select jsonb_agg(e) from jsonb_array_elements(coalesce(p, '[]'::jsonb)) e
                         where not calldesk.deceased_hit(p_phone, e)), '[]'::jsonb) end
$$;

-- followups and today's/later untouched queue rows without deceased pets
create or replace function calldesk.deceased_clean(p_day date default null)
 returns jsonb language plpgsql security definer set search_path to 'calldesk', 'public' as $$
declare
  d date := coalesce(p_day, calldesk.today());
  n_f int; n_fd int; n_q int; n_qd int;
begin
  delete from calldesk.followups f
   where exists (select 1 from calldesk.deceased_map m where m.phone = f.phone and m.all_dead)
      or (f.phone in (select phone from calldesk.deceased_map) and f.reasons <> '[]'::jsonb
          and calldesk.deceased_strip(f.phone, f.reasons) = '[]'::jsonb);
  get diagnostics n_fd = row_count;
  with x as (select f.phone, f.reasons old, calldesk.deceased_strip(f.phone, f.reasons) new from calldesk.followups f
              where f.phone in (select phone from calldesk.deceased_map))
  update calldesk.followups f set reasons = x.new, updated_at = now() from x
   where f.phone = x.phone and x.new is distinct from x.old;
  get diagnostics n_f = row_count;
  with x as (select q.id, q.reasons r0, q.pets p0, calldesk.deceased_strip(q.phone, q.reasons) r1, calldesk.deceased_strip(q.phone, q.pets) p1
               from calldesk.queue q
              where q.list_date >= d and q.dialed_at is null and q.called_at is null and q.connected_at is null
                and q.outcome is null and q.note is null)
  update calldesk.queue q set reasons = x.r1, pets = x.p1 from x
   where q.id = x.id and (x.r1 is distinct from x.r0 or x.p1 is distinct from x.p0);
  get diagnostics n_q = row_count;
  delete from calldesk.queue q
   where q.list_date >= d and q.dialed_at is null and q.called_at is null and q.connected_at is null
     and q.outcome is null and q.note is null
     and (q.reasons = '[]'::jsonb or exists (select 1 from calldesk.deceased_map m where m.phone = q.phone and m.all_dead));
  get diagnostics n_qd = row_count;
  return jsonb_build_object('followups_cleaned', n_f, 'followups_removed', n_fd, 'rows_cleaned', n_q, 'rows_removed', n_qd);
end $$;

-- after each load of deceased_pets: rebuild the map, then clean (set-based: a few seconds)
create or replace function calldesk.deceased_apply()
 returns jsonb language plpgsql security definer set search_path to 'calldesk', 'public' as $$
declare d date := calldesk.today(); res jsonb;
begin
  create temp table t_dsales on commit drop as
  select distinct calldesk.norm_phone(s.client_phone) phone, substring(s.client_id from '\(([^)]*)\)') pet_id, lower(trim(s.patient_name)) lc
    from vetbuddy.sales s where s.client_id is not null and s.client_phone is not null;
  delete from t_dsales where phone is null or pet_id is null;
  create temp table t_dappt on commit drop as
  select distinct calldesk.norm_phone(ap.phone) phone, substring(ap.pet from '\((\d+)\)') pet_id,
         lower(trim(regexp_replace(ap.pet, '\s*\(\d+\).*$', ''))) lc, lower(trim(ap.client)) client, max(ap.appt_date) last_date
    from calldesk.appointments ap where ap.phone is not null group by 1, 2, 3, 4;
  delete from t_dappt where phone is null;
  create temp table t_dp on commit drop as
  select pet_id, lower(trim(pet_name)) lc, lower(trim(client_name)) client from calldesk.deceased_pets;
  delete from calldesk.deceased_map;
  insert into calldesk.deceased_map (phone, pet_id, pet_lc)
  select distinct x.phone, x.pet_id, x.lc from (
    select s.phone, dp.pet_id, s.lc from t_dsales s join t_dp dp on dp.pet_id = s.pet_id
    union all
    select s.phone, dp.pet_id, dp.lc from t_dsales s join t_dp dp on dp.pet_id = s.pet_id
    union all   -- before 20 Dec 2025: one summary row per phone, matched by client + last pet name
    select o.phone, dp.pet_id, dp.lc from vetbuddy.sales_old_summary o
      join t_dp dp on dp.client = lower(trim(o.client_name)) and dp.lc = lower(trim(o.last_pet))
    union all   -- appointments ("Name (12345) &nbsp"): by pet id
    select a.phone, dp.pet_id, dp.lc from t_dappt a join t_dp dp on dp.pet_id = a.pet_id
    union all   -- appointments: by client + pet name
    select a.phone, dp.pet_id, dp.lc from t_dappt a join t_dp dp on dp.client = a.client and dp.lc = a.lc
  ) x where x.phone is not null and coalesce(x.lc, '') <> '';
  -- numbers with a living pet we know of: billed, in the old summary, or an appointment from 30 days ago on
  create temp table t_dlive on commit drop as
  select s.phone from t_dsales s where s.phone in (select phone from calldesk.deceased_map)
     and not exists (select 1 from t_dp dp where dp.pet_id = s.pet_id)
  union
  select o.phone from vetbuddy.sales_old_summary o where o.phone in (select phone from calldesk.deceased_map)
     and not exists (select 1 from calldesk.deceased_map m where m.phone = o.phone and m.pet_lc = lower(trim(o.last_pet)))
  union
  select a.phone from t_dappt a where a.last_date >= d - 30 and a.phone in (select phone from calldesk.deceased_map)
     and (a.pet_id is null or not exists (select 1 from t_dp dp where dp.pet_id = a.pet_id))
     and not exists (select 1 from calldesk.deceased_map m where m.phone = a.phone and m.pet_lc = a.lc);
  update calldesk.deceased_map m set all_dead = not exists (select 1 from t_dlive l where l.phone = m.phone);
  res := calldesk.deceased_clean(d);
  return res || jsonb_build_object('pets', (select count(*) from calldesk.deceased_pets),
                                   'numbers', (select count(distinct phone) from calldesk.deceased_map),
                                   'numbers_all_deceased', (select count(distinct phone) from calldesk.deceased_map where all_dead));
end $$;
revoke all on function calldesk.deceased_hit(text, jsonb), calldesk.deceased_strip(text, jsonb), calldesk.deceased_clean(date), calldesk.deceased_apply() from public, anon, authenticated;
grant execute on function calldesk.deceased_apply() to vb_loader;

-- visible_ids / row_visible / cd_list / build_list: patched from their live text, in the SQL editor:
--   visible_ids  jsonb_array_elements(q.reasons)            -> jsonb_array_elements(calldesk.deceased_strip(q.phone, q.reasons))
--   row_visible  calldesk.strip_off(q.reasons)              -> calldesk.strip_off(calldesk.deceased_strip(q.phone, q.reasons))
--   cd_list      'reasons', calldesk.strip_off(q.reasons)   -> 'reasons', calldesk.strip_off(calldesk.deceased_strip(q.phone, q.reasons))
--                'pets', q.pets                             -> 'pets', calldesk.deceased_strip(q.phone, q.pets)
--   build_list   after "create index on t_pet (phone);"     + delete from t_pet p where exists (select 1 from calldesk.deceased_pets x where x.pet_id = p.pet_id);
--                after the empty-row delete of carried rows + perform calldesk.deceased_clean(d);
--                before "create temp table t_row"           + delete from t_cand c where pet id deceased or calldesk.deceased_hit(phone, {pet});
-- The live definitions after the change are in sql/live/.
