-- live definition of calldesk.deceased_apply() - exported from the database
CREATE OR REPLACE FUNCTION calldesk.deceased_apply()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare d date := calldesk.today(); res jsonb;
begin
  -- pets marked deceased by the agents (cd_pet_deceased) come back after the full VetBuddy reload
  insert into calldesk.deceased_pets (pet_id, pet_name, client_name, first_active, last_active, source)
  select pet_id, pet_name, client_name, first_active::text, last_active, 'calldesk' from calldesk.deceased_marked
  on conflict (pet_id) do nothing;
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
    union all
    select o.phone, dp.pet_id, dp.lc from vetbuddy.sales_old_summary o
      join t_dp dp on dp.client = lower(trim(o.client_name)) and dp.lc = lower(trim(o.last_pet))
    union all
    select a.phone, dp.pet_id, dp.lc from t_dappt a join t_dp dp on dp.pet_id = a.pet_id
    union all
    select a.phone, dp.pet_id, dp.lc from t_dappt a join t_dp dp on dp.client = a.client and dp.lc = a.lc
  ) x where x.phone is not null and coalesce(x.lc, '') <> '';
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
end $function$
;
