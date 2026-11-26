-- live definition of calldesk.build_list(p_day date, p_rebuild boolean) - exported from the database
CREATE OR REPLACE FUNCTION calldesk.build_list(p_day date DEFAULT NULL::date, p_rebuild boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare
  d        date := coalesce(p_day, calldesk.today());
  r        record;
  a        int;
  stats    jsonb;
  capacity int;
  dropped  int := 0;
begin
  perform calldesk.refresh_status(d - 14);
  if p_rebuild then
    delete from calldesk.queue where list_date = d and dialed_at is null and called_at is null and outcome is null and note is null;
    update calldesk.queue set superseded = false
     where list_date between d - 7 and d - 1 and superseded
       and not exists (select 1 from calldesk.queue x where x.list_date = d and x.phone = queue.phone);
  elsif exists (select 1 from calldesk.queue where list_date = d) then
    return jsonb_build_object('day', d, 'skipped', 'list already built (use p_rebuild => true)');
  end if;
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
  -- deceased pets (VetBuddy, loaded every morning): no reasons, no pet cards (23 Nov 2026)
  delete from t_pet p where exists (select 1 from calldesk.deceased_pets x where x.pet_id = p.pet_id);
  create temp table t_cand (phone text, client text, unit text, pet_id text, pet text,
                            type text, rank int, label text, due date, score numeric) on commit drop;
  
  insert into t_cand
  select calldesk.norm_phone(ap.phone), ap.client, upper(ap.clinic), null, ap.pet, 'appt_tomorrow', 2,
         'Appointment tomorrow ' || coalesce(substring(ap.appt_time from '\d{1,2}:\d{2}\s*[ap]m'), '') ||
         coalesce(' - ' || nullif(ap.appt_type, ''), '') || ' - confirm', ap.appt_date, 0
  from calldesk.appointments ap
  where ap.appt_date = d + 1 and coalesce(ap.status, '') !~* 'cancel|no.?show'
    and calldesk.norm_phone(ap.phone) is not null;
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
    and not exists (select 1 from t_pet p where p.phone = calldesk.norm_phone(ap.phone) and p.last_visit >= ap.appt_date)
    -- spoken to after the no-show (a real conversation, 15+ seconds): not called again for it
    and not exists (select 1 from calldesk.calls k where k.phone = calldesk.norm_phone(ap.phone) and k.answered and k.call_at >= ap.appt_date::timestamp);
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'post_surgery', 4,
         'Post-surgery check, day ' || (d - s.sale_date) || ' (surgery ' || to_char(s.sale_date, 'DD Mon') || ')',
         s.sale_date, 0
  from (select distinct substring(client_id from '\(([^)]*)\)') pet_id, sale_date
          from vetbuddy.sales
         where plan_subcategory ilike 'surgery' and sale_date in (d - 2, d - 7)) s
  join t_pet p on p.pet_id = s.pet_id
  where (d - s.sale_date) = 2 or p.last_visit <= s.sale_date;
  insert into t_cand
  select coalesce(calldesk.norm_phone(rm.phone), p.phone), coalesce(nullif(rm.client, ''), p.client_name),
         coalesce(p.unit, upper(rm.clinic)), rm.patient_id, rm.pet,
         case when rm.purpose ~* 'vaccin|booster|rabies|dhpp|tri ?cat|arv|lepto|kennel|corona' then 'vaccine_due'
              when rm.purpose ~* 'review|follow' then 'review_due'
              when rm.purpose ~* 'hair ?cut|trim|styl' then 'haircut_due' when rm.purpose ~* 'bath|groom|spa|nail|hygien' then 'bath_due'
              when rm.purpose ~* 'report' then 'report_ready'
              else 'reminder' end,
         case when rm.purpose ~* 'hair ?cut|trim|styl' then 8 when rm.purpose ~* 'bath|groom|spa|nail|hygien' then 7 else 5 end,
         case when rm.purpose ~* 'vaccin|booster|rabies|dhpp|tri ?cat|arv|lepto|kennel|corona' then 'Vaccine due '
              when rm.purpose ~* 'review|follow' then 'Review due '
              when rm.purpose ~* 'hair ?cut|trim|styl' then 'Haircut due ' when rm.purpose ~* 'bath|groom|spa|nail|hygien' then 'Bath due '
              when rm.purpose ~* 'report' then 'Report ready to collect '
              else 'Reminder due ' end || to_char(rm.due, 'DD Mon') || ': ' || rm.purpose,
         rm.due, -(rm.due - d)
  from calldesk.reminders rm
  left join t_pet p on p.pet_id = rm.patient_id
  where rm.due between d - 1 and d + 1
    and coalesce(calldesk.norm_phone(rm.phone), p.phone) is not null
    and not exists (select 1 from calldesk.calls k where k.phone = coalesce(calldesk.norm_phone(rm.phone), p.phone)
                     and k.call_at >= (rm.due - 3)::timestamp);
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'bath_due', 7,
         'Bath due - last bath ' || to_char(p.last_bathing_visit, 'DD Mon') || case when coalesce(p.bathing_visit_count, 0) >= 3 then ' (regular: ' || p.bathing_visit_count || ' baths, usually every ' || greatest(20, least(90, (p.last_bathing_visit - p.first_bathing_visit) / (p.bathing_visit_count - 1))) || ' days)' else '' end, p.last_bathing_visit + 30,
         d - p.last_bathing_visit
  from t_pet p
  where p.last_visit <= p.last_bathing_visit and ((coalesce(p.bathing_visit_count, 0) >= 3 and (d - p.last_bathing_visit) between greatest(20, least(90, (p.last_bathing_visit - p.first_bathing_visit) / (p.bathing_visit_count - 1))) and 1.6 * greatest(20, least(90, (p.last_bathing_visit - p.first_bathing_visit) / (p.bathing_visit_count - 1)))) or (coalesce(p.bathing_visit_count, 0) < 3 and p.last_bathing_visit between d - 45 and d - 30));
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'haircut_due', 8,
         'Haircut due - last haircut ' || to_char(p.last_haircut_visit, 'DD Mon') || case when coalesce(p.haircut_visit_count, 0) >= 3 then ' (regular: ' || p.haircut_visit_count || ' haircuts, usually every ' || greatest(30, least(120, (p.last_haircut_visit - p.first_haircut_visit) / (p.haircut_visit_count - 1))) || ' days)' else '' end, p.last_haircut_visit + 45,
         d - p.last_haircut_visit
  from t_pet p
  where p.last_visit <= p.last_haircut_visit and ((coalesce(p.haircut_visit_count, 0) >= 3 and (d - p.last_haircut_visit) between greatest(30, least(120, (p.last_haircut_visit - p.first_haircut_visit) / (p.haircut_visit_count - 1))) and 1.6 * greatest(30, least(120, (p.last_haircut_visit - p.first_haircut_visit) / (p.haircut_visit_count - 1)))) or (coalesce(p.haircut_visit_count, 0) < 3 and p.last_haircut_visit between d - 60 and d - 45));
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'consult_followup', 9,
         'Follow-up after consultation on ' || to_char(p.last_consultation_visit, 'DD Mon'),
         p.last_consultation_visit + 7, 0
  from t_pet p
  where p.last_consultation_visit between d - 9 and d - 7 and p.last_visit <= p.last_consultation_visit;
  
  insert into t_cand
  select calldesk.norm_phone(l.phone), l.name, upper(l.unit), null, null, 'lead', 11,
         'Enquiry' || coalesce(': ' || nullif(l.purpose, ''), '') || ' (' || to_char(l.created_at, 'DD Mon') || ')',
         l.created_at::date, 0
  from calldesk.leads l
  where l.created_at >= (d - 2)::timestamp and l.created_at < d::timestamp
    and coalesce(l.status, '') !~* 'book|convert|closed|visited|done'
    and calldesk.norm_phone(l.phone) is not null;
  
  create temp table t_ext on commit drop as
  select z.pet_id,
         max(case when z.patient_dob_text ~ '^[A-Z][a-z]{2}, \d{2} \d{4}$' then to_date(z.patient_dob_text, 'Mon, DD YYYY') end) as dob,
         max(z.sale_date) filter (where z.item_name ~* 'deworming' and z.item_name !~* 'advice') as last_deworm,
         max(z.sale_date) filter (where z.item_name ~* 'tick' and z.plan_category ilike 'laborator%') as last_tick,
         max(z.sale_date) filter (where z.plan_category ilike 'laborator%' or z.plan_subcategory ilike 'health check%') as last_lab,
         (array_agg(z.item_name order by z.sale_date desc) filter (where z.plan_category ilike 'vaccination%' and z.item_name ilike 'Vaccination &%'))[1] as last_vac_item,
         max(z.sale_date) filter (where z.plan_category ilike 'vaccination%' and z.item_name ilike 'Vaccination &%') as last_vac,
         count(distinct z.sale_date) filter (where z.item_name ~* 'post bite' and z.sale_date >= d - 35) as pb_n,
         max(z.sale_date) filter (where z.plan_subcategory ilike 'holiday boarding') as last_board,
         min(z.sale_date) filter (where z.item_name ~* 'post bite' and z.sale_date >= d - 35) as pb_first,
         (array_agg(z.item_name order by z.sale_date desc) filter (where z.item_name ~* '^Vaccination & Physical Examination' and z.item_name ~* 'DHPP|TRI ?Cat'))[1] as core_item,
         max(z.sale_date) filter (where z.item_name ~* '^Vaccination & Physical Examination' and z.item_name ~* 'DHPP|TRI ?Cat') as core_date,
         (array_agg(z.item_name order by z.sale_date desc) filter (where z.item_name ~* '^Vaccination & Physical Examination - Anti Rabies' and z.item_name !~* 'post bite'))[1] as rab_item,
         max(z.sale_date) filter (where z.item_name ~* '^Vaccination & Physical Examination - Anti Rabies' and z.item_name !~* 'post bite') as rab_date
  from (select substring(client_id from '\(([^)]*)\)') as pet_id, patient_dob_text, sale_date, item_name, plan_category, plan_subcategory
          from vetbuddy.sales where client_id is not null and sale_date >= d - 460 and sale_date < d) z
  group by z.pet_id;
  create index on t_ext (pet_id);
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'rabies_course', 4,
         'Anti-rabies (post bite) course: dose ' || (e.pb_n + 1) || ' of 5 due on ' || to_char(e.pb_first + (array[3,7,14,28])[e.pb_n], 'DD Mon') ||
         ' (course started ' || to_char(e.pb_first, 'DD Mon') || ', ' || e.pb_n || case when e.pb_n = 1 then ' dose' else ' doses' end || ' given)',
         e.pb_first + (array[3,7,14,28])[e.pb_n], d - (e.pb_first + (array[3,7,14,28])[e.pb_n])
  from t_pet p join t_ext e using (pet_id)
  where e.pb_n between 1 and 4
    and d between e.pb_first + (array[3,7,14,28])[e.pb_n] - 1 and e.pb_first + (array[3,7,14,28])[e.pb_n] + 7;
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'vaccine_course', case when v.nxt ~* 'annual' then 6 else 5 end,
         'Next vaccine due ' || to_char(v.due, 'DD Mon') || ': ' || v.nxt || ' (last: ' || regexp_replace(v.last_item, '^Vaccination & Physical Examination\s*-\s*', '') || ' on ' || to_char(v.last_date, 'DD Mon YYYY') || ')',
         v.due, d - v.due
  from t_pet p join t_ext e using (pet_id)
  cross join lateral (
    -- vaccine chart (20 Nov 2026): Primary 45 d -> 1st booster 66 d -> 2nd booster (+ARV) 90 d -> 3rd booster 111 d -> Annual at 1 year -> every year;
    -- unvaccinated pets: UV -> UV booster 21 days later -> Annual; Anti Rabies: Primary 90 d -> Booster 111 d -> Annual
    select x.last_item, x.last_date, x.nxt,
           greatest(coalesce(case when e.dob < x.last_date then e.dob + x.age end, x.last_date + x.gap), x.last_date + x.min_gap) as due
      from (
        select e.core_item last_item, e.core_date last_date,
               case when e.core_item ~* 'DHPP' then 'DHPPIL' else 'TRI Cat' end ||
               case when e.core_item ~* 'uv\s*-\s*booster' then ' + ARV (Annual)'
                    when e.core_item ~* '\(\s*uv\s*\)' then ' + ARV (UV - Booster)'
                    when e.core_item ~* 'primary' then ' (1st booster)'
                    when e.core_item ~* '1st booster' then ' + ARV (2nd booster)'
                    when e.core_item ~* '2nd booster' then ' + ARV (3rd booster)'
                    else ' + ARV (Annual)' end as nxt,
               case when e.core_item ~* 'uv' then null when e.core_item ~* 'primary' then 66 when e.core_item ~* '1st booster' then 90
                    when e.core_item ~* '2nd booster' then 111 when e.core_item ~* '3rd booster' then 365 end as age,
               case when e.core_item ~* 'uv\s*-\s*booster' then 344 when e.core_item ~* '\(\s*uv\s*\)' then 21 when e.core_item ~* 'primary' then 21
                    when e.core_item ~* '1st booster' then 24 when e.core_item ~* '2nd booster' then 21 when e.core_item ~* '3rd booster' then 254 else 365 end as gap,
               case when e.core_item ~* 'annual' then 300 when e.core_item ~* '3rd booster|uv\s*-\s*booster' then 120 else 14 end as min_gap
         where e.core_item is not null
        union all
        select e.rab_item, e.rab_date,
               'Anti Rabies (' || case when e.rab_item ~* 'primary' then 'Booster' else 'Annual' end || ')',
               case when e.rab_item ~* 'primary' then 111 when e.rab_item ~* 'booster' then 365 end,
               case when e.rab_item ~* 'primary' then 21 when e.rab_item ~* 'booster' then 254 else 365 end,
               case when e.rab_item ~* 'annual' then 300 when e.rab_item ~* 'booster' then 120 else 14 end
         where e.rab_item is not null
           -- the core course already carries ARV from the 2nd booster: no separate rabies call then
           and not (e.core_item ~* 'ARV' and e.core_date >= e.rab_date)) x) v
  where d between v.due - case when v.nxt ~* 'annual' then 7 else 3 end and v.due + 30
    and not exists (select 1 from calldesk.calls k where k.phone = p.phone and k.call_at >= (v.due - 10)::timestamp and k.answered);
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'deworm_due', 6,
         'Deworming due - last done on ' || to_char(e.last_deworm, 'DD Mon') || ' (' || iv.txt || ')', e.last_deworm + iv.days, d - (e.last_deworm + iv.days)
  from t_pet p join t_ext e using (pet_id)
  cross join lateral (select case when e.dob is not null and e.last_deworm - e.dob < 90 then 21
                                  when e.dob is not null and e.last_deworm - e.dob < 180 then 30 else 90 end as days,
                             case when e.dob is not null and e.last_deworm - e.dob < 90 then 'every 3 weeks under 3 months old'
                                  when e.dob is not null and e.last_deworm - e.dob < 180 then 'monthly up to 6 months old'
                                  else 'every 3 months' end as txt) iv
  where d between e.last_deworm + iv.days - 3 and e.last_deworm + iv.days + 30;
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'tick_recheck', 6,
         'Tick fever test on ' || to_char(e.last_tick, 'DD Mon') || ', no visit since - ask how the pet is, offer review / re-test', e.last_tick, d - e.last_tick
  from t_pet p join t_ext e using (pet_id)
  where d - e.last_tick between 10 and 30 and p.last_visit <= e.last_tick;
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'sibling_vaccine', 9,
         'Vaccination check: no vaccine with us since ' || to_char(greatest(d - 365, date '2025-12-20'), 'Mon YYYY') || ', but ' || sb.pet_name || ' (same owner) was vaccinated on ' || to_char(sb.last_vaccination_visit, 'DD Mon'),
         sb.last_vaccination_visit, coalesce(p.total_client_revenue, 0)
  from t_pet p
  join lateral (select o.pet_name, o.last_vaccination_visit from t_pet o where o.phone = p.phone and o.pet_id <> p.pet_id
                 and o.last_vaccination_visit >= d - 90 order by o.last_vaccination_visit desc limit 1) sb on true
  where p.last_vaccination_visit is null and p.last_visit >= d - 180 and p.species ~* 'canine|feline|dog|cat';
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'birthday', 10,
         'Birthday on ' || to_char(e.dob, 'DD Mon') || ' (turning ' || (extract(year from d)::int - extract(year from e.dob)::int) || ') - wish them, offer a birthday groom / health check',
         d, coalesce(p.total_client_revenue, 0)
  from t_pet p join t_ext e using (pet_id)
  where e.dob is not null and p.last_visit >= d - 180 and extract(year from e.dob) < extract(year from d)
    and to_char(e.dob, 'MMDD') between to_char(d, 'MMDD') and to_char(d + 3, 'MMDD');
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'senior_check', 11,
         'Senior ' || sr.kind || ' (' || ((d - e.dob) / 365) || ' yrs, senior from ' || sr.yrs || '): ' ||
         case when e.last_lab is null then 'no health check or lab test with us in the last 6 months' else 'last health check / lab on ' || to_char(e.last_lab, 'DD Mon') end || ' - offer a senior check-up',
         d, coalesce(p.total_client_revenue, 0)
  from t_pet p join t_ext e using (pet_id)
  left join lateral (select nullif(regexp_replace(b.obase_weight::text, '[^0-9.]', '', 'g'), '')::numeric w
                       from vetbuddy.ref_breed_obase b where lower(trim(b.breed)) = lower(trim(p.breed)) limit 1) bw on true
  cross join lateral (select case when p.species ~* 'feline|cat' then 10
                                  when p.species ~* 'canine|dog' then case when bw.w >= 48 then 5 when bw.w >= 30 then 6 when bw.w < 13 then 8 else 7 end end as yrs,
                             case when p.species ~* 'feline|cat' then 'cat'
                                  when bw.w >= 48 then 'giant-breed dog' when bw.w >= 30 then 'large-breed dog' when bw.w < 13 then 'small-breed dog' else 'dog' end as kind) sr
  where sr.yrs is not null and e.dob is not null and d - e.dob >= sr.yrs * 365
    and p.last_visit between d - 365 and d - 30 and (e.last_lab is null or e.last_lab < d - 180);
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'vaccine_never', 11,
         'Grooming regular (' || p.bathing_visit_count || ' baths), no vaccination with us since ' || to_char(greatest(d - 365, date '2025-12-20'), 'Mon YYYY') || ' - check vaccine and deworming status',
         d, coalesce(p.total_client_revenue, 0)
  from t_pet p
  where coalesce(p.bathing_visit_count, 0) >= 2 and p.last_bathing_visit >= d - 120 and p.last_vaccination_visit is null
    and p.species ~* 'canine|feline|dog|cat';
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'boarding_holiday', 10,
         h.name || ' from ' || to_char(h.starts, 'DD Mon') || ' - boarded with us on ' || to_char(e.last_board, 'DD Mon YYYY') || ' - offer to book boarding early',
         h.starts, coalesce(p.total_client_revenue, 0)
  from t_pet p join t_ext e using (pet_id)
  join calldesk.holidays h on d between h.starts - 21 and h.starts - 7
  where e.last_board is not null;
  -- Sanchu's Elite Grooming Club: Bath (Rs 1,500 = 6 free baths) / Full Groom (Rs 2,500 = 6 baths + 2 haircuts), 3 months, per pet
  create temp table t_sub on commit drop as
  with s as (select substring(client_id from '\(([^)]*)\)') as pet_id, sale_date, item_name from vetbuddy.sales
              where client_id is not null and sale_date >= d - 200 and sale_date < d
                and item_name in ('Bath Subscription Plan', 'Bath & Haircut Subscription Plan', 'Subscription Bath', 'Subscription Haircut')),
       b as (select distinct on (pet_id) pet_id, sale_date as bought, item_name as plan from s where item_name like '%Plan' order by pet_id, sale_date desc)
  select b.pet_id, b.bought, (b.bought + interval '3 months')::date as ends,
         case when b.plan like 'Bath & Haircut%' then 'Elite Full Groom subscription' else 'Elite Bath subscription' end as pname,
         case when b.plan like 'Bath & Haircut%' then 2 else 0 end as cuts,
         count(*) filter (where s.item_name = 'Subscription Bath' and s.sale_date between b.bought and (b.bought + interval '3 months')::date)::int as baths_used,
         count(*) filter (where s.item_name = 'Subscription Haircut' and s.sale_date between b.bought and (b.bought + interval '3 months')::date)::int as cuts_used,
         max(s.sale_date) filter (where s.item_name like 'Subscription %' and s.sale_date between b.bought and (b.bought + interval '3 months')::date) as last_use
  from b left join s on s.pet_id = b.pet_id
  group by b.pet_id, b.bought, b.plan;
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'sub_expiring', 4,
         u.pname || ' ends on ' || to_char(u.ends, 'DD Mon') || ' with ' || greatest(6 - u.baths_used, 0) || ' free bath(s)' ||
         case when u.cuts - u.cuts_used > 0 then ' + ' || (u.cuts - u.cuts_used) || ' free haircut(s)' else '' end || ' unused - book now so they are not lost',
         u.ends, -(u.ends - d)
  from t_pet p join t_sub u using (pet_id)
  where d <= u.ends and u.ends - d <= 21 and (u.baths_used < 6 or u.cuts_used < u.cuts);
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'sub_due', 6,
         u.pname || ': ' || u.baths_used || ' of 6 free baths used' ||
         case when u.cuts > 0 then ', ' || u.cuts_used || ' of 2 haircuts used' else '' end ||
         ' - valid till ' || to_char(u.ends, 'DD Mon') || ', last visit ' || to_char(coalesce(u.last_use, u.bought), 'DD Mon') || ' - book the next one',
         coalesce(u.last_use, u.bought) + 14, d - coalesce(u.last_use, u.bought)
  from t_pet p join t_sub u using (pet_id)
  where d <= u.ends and u.ends - d > 21 and (u.baths_used < 6 or u.cuts_used < u.cuts)
    and d - coalesce(u.last_use, u.bought) >= 14 and p.last_visit <= coalesce(u.last_use, u.bought);
  insert into t_cand
  select p.phone, p.client_name, p.unit, p.pet_id, p.pet_name, 'sub_renew', 7,
         u.pname || ' finished' ||
         case when u.baths_used >= 6 and u.cuts_used >= u.cuts then ' - all free visits used'
              else ' on ' || to_char(u.ends, 'DD Mon') || ' (' || u.baths_used || ' of 6 baths used)' end ||
         ' - offer to renew (Rs ' || case when u.cuts > 0 then '2,500: 6 baths + 2 haircuts' else '1,500: 6 baths' end || ', 3 months)',
         least(u.ends, coalesce(u.last_use, u.ends)), coalesce(p.total_client_revenue, 0)
  from t_pet p join t_sub u using (pet_id)
  where (d > u.ends and d - u.ends <= 30)
     or (u.baths_used >= 6 and u.cuts_used >= u.cuts and d - u.last_use between 7 and 30);
  delete from t_cand c where c.type in ('bath_due', 'haircut_due')
     and exists (select 1 from t_cand x where x.type in ('sub_due', 'sub_expiring', 'sub_renew') and x.phone = c.phone and x.pet_id = c.pet_id);
  delete from t_cand a using t_cand b where a.type = 'vaccine_course' and b.type = 'vaccine_due' and a.phone = b.phone and lower(coalesce(a.pet, '')) = lower(coalesce(b.pet, ''));
  delete from t_cand a using t_cand b where a.type = 'vaccine_never' and b.type = 'sibling_vaccine' and a.phone = b.phone and a.pet_id = b.pet_id;
  delete from t_cand a using t_cand b
   where a.phone = b.phone and a.type = b.type and a.ctid > b.ctid
     and lower(coalesce(a.pet_id, a.pet, '')) in (lower(coalesce(b.pet_id, b.pet, '')), lower(coalesce(b.pet, '')));
  delete from t_cand where type in ('lead', 'report_ready', 'birthday');
  -- key customers: 2+ pets on the number, no visit (any pet) for 45 days to a year - check in, book for all pets
  insert into t_cand
  select g.phone, g.client, g.unit, null, g.names, 'multi_pet', 8,
         'Key customer - ' || g.n || ' pets (' || g.names || ') - last visit ' || to_char(g.last, 'DD Mon') || ' (' || (d - g.last) || ' days ago)' ||
         case when g.spend > 0 then ', spent Rs ' || to_char(round(g.spend), 'FM99,99,999') else '' end || ' - check in, book for all pets',
         g.last, g.spend
  from (select phone, (array_agg(client_name order by last_visit desc))[1] client, (array_agg(unit order by last_visit desc))[1] unit,
               count(*) n, left(string_agg(initcap(regexp_replace(pet_name, '\s*\(\d+\).*$', '')), ', ' order by last_visit desc), 80) names,
               max(last_visit) last, sum(coalesce(total_client_revenue, 0)) spend
          from t_pet group by phone having count(*) >= 2) g
  where g.last between d - 365 and d - 45;
  -- churned: the number has not been billed for more than a year (up to 2 years) - follow up, invite back
  insert into t_cand
  select c.phone, c.client, c.unit, null, c.pet, 'churned', 12,
         'Not visited for over a year - last visit ' || to_char(c.last, 'DD Mon YYYY') || coalesce(' (' || c.item || ')', '') ||
         ', ' || c.days || case when c.days = 1 then ' visit day' else ' visit days' end ||
         case when c.spend > 0 then ', spent Rs ' || to_char(round(c.spend), 'FM99,99,999') else '' end || ' - follow up, invite back',
         c.last, c.spend
  from (select u.phone, (array_agg(u.client order by u.last desc))[1] client, (array_agg(u.unit order by u.last desc))[1] unit,
               (array_agg(u.pet order by u.last desc))[1] pet, (array_agg(u.item order by u.last desc))[1] item,
               max(u.last) last, sum(u.days)::int days, sum(u.spend) spend
          from (select calldesk.norm_phone(client_phone) phone, max(client_name) client, (array_agg(sales_unit order by sale_date desc))[1] unit,
                       (array_agg(patient_name order by sale_date desc))[1] pet, (array_agg(item_name order by sale_date desc))[1] item,
                       max(sale_date) last, count(distinct sale_date) days, sum(amount) spend
                  from vetbuddy.sales where client_id is not null and sale_date < d group by 1
                union all   -- before 20 Dec 2025: one summary row per phone (vetbuddy.sales_old_summary)
                select phone, client_name, last_unit, last_pet, last_services, last_date, visit_days, spend
                  from vetbuddy.sales_old_summary where last_date < d) u
         group by u.phone) c
  where c.phone is not null and c.last between d - 730 and d - 366;
  delete from t_cand where type in (select type from calldesk.reason_off);
  -- key customer / churned check-ins: not again within 90 days of being reached or closed
  delete from t_cand c where c.type in ('multi_pet', 'churned') and exists (
     select 1 from calldesk.queue q where q.phone = c.phone and q.list_date between d - 90 and d - 1
        and q.reasons @> jsonb_build_array(jsonb_build_object('type', c.type))
        and (q.connected_at is not null or q.outcome is not null or q.called_at is not null));
  -- team lead switch: not called again within N days of an outgoing call (Corefactor / Runo)
  delete from t_cand c where calldesk.omitted(c.phone);   -- switched off by the team lead   -- not called (decided 16 Nov 2026)
  delete from t_cand c where c.phone is null or c.phone !~ '^[6-9]\d{9}$'
     or exists (select 1 from calldesk.exclusions x where x.phone = c.phone);
  delete from t_cand c where c.rank >= 7
     and exists (select 1 from calldesk.calls k where k.phone = c.phone and k.call_at >= (d - 3)::timestamp);
  delete from t_cand c where exists (
     select 1 from calldesk.queue q
      where q.phone = c.phone and q.list_date between d - 30 and d - 1
        and q.reasons @> jsonb_build_array(jsonb_build_object('type', c.type))
        and (q.connected_at is not null or q.outcome is not null or q.tries >= 3));
  -- the loop (17 Nov 2026): no number leaves. From the last list day:
  --   called (marked by the agent, answered in the logs, or closed): back the next day if it had 2+ dues, else in 7 days
  --   not reached after 3 tries: back in 7 days
  insert into calldesk.followups (phone, due, reasons, why, from_list)
  select q.phone,
         q.list_date + case when (select count(*) from jsonb_array_elements(q.reasons) e where e->>'type' not in ('callback', 'followup')) >= 2 then 2 else 7 end,
         (select coalesce(jsonb_agg(e), '[]') from jsonb_array_elements(q.reasons) e where e->>'type' not in ('callback', 'followup')),
         'called', q.list_date
  from calldesk.queue q
  where q.list_date = (select max(list_date) from calldesk.queue where list_date < d) and not q.superseded
    and (q.called_at is not null or q.connected_at is not null or (q.outcome is not null and q.outcome <> 'callback'))
    and coalesce(q.outcome, '') <> 'callback'
  on conflict (phone) do update set due = excluded.due, reasons = excluded.reasons, why = excluded.why, from_list = excluded.from_list, updated_at = now();
  insert into calldesk.followups (phone, due, reasons, why, from_list)
  select q.phone, d + 6,
         (select coalesce(jsonb_agg(e), '[]') from jsonb_array_elements(q.reasons) e where e->>'type' not in ('callback', 'followup')),
         'no answer', coalesce(q.carried_from, q.list_date)
  from calldesk.queue q
  where q.list_date = (select max(list_date) from calldesk.queue where list_date < d) and not q.superseded
    and q.called_at is null and q.connected_at is null and q.outcome is null
    and q.tries + (q.attempted_at is not null)::int >= 3
  on conflict (phone) do update set due = excluded.due, reasons = excluded.reasons, why = excluded.why, from_list = excluded.from_list, updated_at = now();
  create temp table t_carry on commit drop as
  select q.* from calldesk.queue q
  -- 26-11-2026: call-backs are carried on their date however far ahead they were set (up to 90 days), not only within 7 days
  where q.list_date between d - 90 and d - 1 and not q.superseded
    and ((q.list_date >= d - 7 and q.connected_at is null and q.called_at is null and q.outcome is null and q.tries + (q.attempted_at is not null)::int < 3)
         or (q.outcome = 'callback' and (q.callback_at at time zone 'Asia/Kolkata')::date <= d))
    and not exists (select 1 from calldesk.exclusions x where x.phone = q.phone);
  delete from t_carry c where c.outcome is distinct from 'callback' and calldesk.omitted(c.phone);
  -- carried rows fill at most 60% of the team's capacity (most urgent first, call-backs always);
  -- the rest wait in the follow-up list with their priority and come back when there is room - nothing is lost
  insert into calldesk.followups (phone, due, reasons, why, from_list)
  select c.phone, d + 1,
         (select coalesce(jsonb_agg(e), '[]') from jsonb_array_elements(c.reasons) e where e->>'type' not in ('callback', 'followup', 'checkin')),
         'called', d - 1
  from (select distinct on (phone) * from t_carry order by phone, list_date desc) c
  where c.outcome is distinct from 'callback' and calldesk.called_on(c.phone, d - 1)
  on conflict (phone) do nothing;
  update calldesk.queue q set superseded = true
   where q.id in (select id from t_carry tc where tc.outcome is distinct from 'callback' and calldesk.called_on(tc.phone, d - 1));
  delete from t_carry tc where tc.outcome is distinct from 'callback' and calldesk.called_on(tc.phone, d - 1);
  create temp table t_carry_keep on commit drop as
  select z.id from (
    select c.id, c.outcome, row_number() over (order by (c.outcome = 'callback') desc, c.rank, c.score desc nulls last, c.id) rn
      from (select distinct on (phone) * from t_carry order by phone, list_date desc) c) z
  where z.outcome = 'callback'
     or z.rn <= (select floor(0.6 * coalesce(sum(daily_target), 0)) from calldesk.agents ax where ax.active and not calldesk.is_off(ax.id, d) and ax.role = 'agent' and daily_target > 0 and department in (select name from calldesk.departments where calls));
  insert into calldesk.followups (phone, due, reasons, why, from_list)
  select c.phone, d,
         (select coalesce(jsonb_agg(e), '[]') from jsonb_array_elements(c.reasons) e where e->>'type' not in ('callback', 'checkin')),
         'waiting', coalesce(c.carried_from, c.list_date)
  from (select distinct on (phone) * from t_carry order by phone, list_date desc) c
  where c.id not in (select id from t_carry_keep)
    and exists (select 1 from jsonb_array_elements(c.reasons) e where e->>'type' not in ('callback', 'checkin'))   -- check-ins are filler: not parked
  on conflict (phone) do nothing;
  update calldesk.queue q set superseded = true
   where q.id in (select id from t_carry) and q.phone not in (select tc.phone from t_carry tc where tc.id in (select id from t_carry_keep));
  delete from t_carry where phone not in (select tc.phone from t_carry tc where tc.id in (select id from t_carry_keep));
  insert into calldesk.queue (list_date, agent_id, phone, client, unit, rank, score, reasons, pets, tries, carried_from, outcome, callback_at)
  select d, c.agent_id, c.phone, c.client, c.unit,
         case when c.outcome = 'callback' then 0 else c.rank end, c.score,
         case when c.outcome = 'callback'
              then jsonb_build_array(jsonb_build_object('type', 'callback', 'rank', 0, 'set_on', to_char(coalesce((select (e->>'set_on')::date from jsonb_array_elements(c.reasons) e where e->>'type' = 'callback' and e ? 'set_on' limit 1), (c.updated_at at time zone 'Asia/Kolkata')::date), 'YYYY-MM-DD'),
                     'label', 'Call back – promised on ' || to_char(coalesce((select (e->>'set_on')::date from jsonb_array_elements(c.reasons) e where e->>'type' = 'callback' and e ? 'set_on' limit 1), (c.updated_at at time zone 'Asia/Kolkata')::date), 'DD Mon') || ' for ' || to_char(case when (c.callback_at at time zone 'Asia/Kolkata')::date < d then d + (c.callback_at at time zone 'Asia/Kolkata')::time else c.callback_at at time zone 'Asia/Kolkata' end, 'DD Mon, HH12:MI am')
                              || coalesce(' - ' || c.note, '')))
                   || (select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements(c.reasons) e where e->>'type' <> 'callback')
              else c.reasons end,
         c.pets, c.tries + (c.attempted_at is not null)::int, coalesce(c.carried_from, c.list_date),
          case when c.outcome = 'callback' then 'callback' end, case when c.outcome = 'callback' then case when (c.callback_at at time zone 'Asia/Kolkata')::date < d then ((d + (c.callback_at at time zone 'Asia/Kolkata')::time) at time zone 'Asia/Kolkata') else c.callback_at end end   -- missed on an earlier day: same time today   -- 26-11-2026: keep the call-back time
  from (select distinct on (phone) * from t_carry order by phone, list_date desc) c
  on conflict (list_date, phone) do nothing;
  update calldesk.queue q set superseded = true from t_carry c where q.id = c.id;
  -- carried rows lose reasons that are no longer called; a row with nothing left is dropped
  update calldesk.queue q
     set reasons = x.r, rank = coalesce(x.mr, q.rank)
    from (select q2.id, coalesce(jsonb_agg(e) filter (where e->>'type' not in ('lead', 'report_ready', 'birthday', 'appt_tomorrow', 'missed_call')), '[]'::jsonb) r,
                 min((e->>'rank')::int) filter (where e->>'type' not in ('lead', 'report_ready', 'birthday', 'appt_tomorrow', 'missed_call')) mr
            from calldesk.queue q2, jsonb_array_elements(q2.reasons) e
           where q2.list_date = d and q2.reasons::text ~ '"(lead|report_ready|birthday|appt_tomorrow|missed_call)"'   -- also date-bound reasons
           group by q2.id) x
   where q.id = x.id;
  delete from calldesk.queue q where q.list_date = d and q.reasons = '[]'::jsonb and q.dialed_at is null and q.outcome is null and q.note is null;
  perform calldesk.deceased_clean(d);   -- carried rows and follow-ups: nothing about a deceased pet (23 Nov 2026)
  delete from t_cand c where exists (select 1 from calldesk.queue q where q.list_date = d and q.phone = c.phone);
  -- follow-ups that are due (the loop): one "Follow-up" reason with what was due last time
  insert into t_cand
  select f.phone, lq.client, lq.unit, null, null, 'followup',
         case when f.why = 'waiting' then coalesce((select min((e->>'rank')::int) from jsonb_array_elements(f.reasons) e), 9) when f.why = 'called' and jsonb_array_length(f.reasons) >= 2 then 5 else 9 end,
         'Follow-up - ' || case when f.why = 'called' then 'called on ' when f.why = 'waiting' then 'waiting since ' else 'no answer 3 times since ' end || to_char(f.from_list, 'DD Mon') ||
         coalesce(': ' || left((select string_agg(x.l, ' | ' order by x.r) from (select regexp_replace(regexp_replace(e->>'label', '\s+-\s+.*$', ''), '\s*\(.*$', '') l, min((e->>'rank')::int) r from jsonb_array_elements(f.reasons) e group by 1) x), 160), ''),
         f.due, 0
  from calldesk.followups f
  left join lateral (select q.client, q.unit from calldesk.queue q where q.phone = f.phone order by q.list_date desc limit 1) lq on true
  where f.due <= d
    and not exists (select 1 from calldesk.queue q where q.list_date = d and q.phone = f.phone)
    and not exists (select 1 from calldesk.exclusions x where x.phone = f.phone)
    and not exists (select 1 from calldesk.reason_off o where o.type = 'followup');
  insert into calldesk.followups (phone, due, reasons, why, from_list)
  select c.phone, d + 1, coalesce(jsonb_agg(jsonb_build_object('type', c.type, 'rank', c.rank, 'label', c.label)) filter (where c.type not in ('followup', 'checkin')), '[]'), 'called', d - 1
    from t_cand c where calldesk.called_on(c.phone, d - 1) group by c.phone
  on conflict (phone) do nothing;
  delete from t_cand c where calldesk.called_on(c.phone, d - 1);
  -- a waiting follow-up whose number also has a fresh due today: the fresh reason wins (the follow-up leaves when the number is placed)
  delete from t_cand c where c.type = 'followup' and exists (select 1 from t_cand c2 where c2.phone = c.phone and c2.type <> 'followup');
  -- nothing about a deceased pet, and no call to a number whose pets are all deceased (23 Nov 2026)
  delete from t_cand c where exists (select 1 from calldesk.deceased_pets x where x.pet_id = c.pet_id)
     or (c.phone in (select phone from calldesk.deceased_map) and calldesk.deceased_hit(c.phone, jsonb_strip_nulls(jsonb_build_object('pet', c.pet))));
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
  create temp table t_agent on commit drop as
  select ag.id, ag.units, ag.daily_target as target,
         (select count(*) from calldesk.queue q where q.list_date = d and q.agent_id = ag.id)::int as n
  from calldesk.agents ag where ag.active and not calldesk.is_off(ag.id, d) and ag.role = 'agent' and ag.daily_target > 0 and ag.department in (select name from calldesk.departments where calls);
  select coalesce(sum(target), 0) into capacity from t_agent;
  for r in select t.*, rp.pets from t_row t join t_rowpets rp using (phone)
           order by (t.rank = 12), row_number() over (partition by t.top_type order by t.score desc nulls last, t.phone)::numeric
                    / case t.top_type when 'missed_call' then 40 when 'appt_tomorrow' then 35 when 'appt_missed' then 20
                                      when 'post_surgery' then 15 when 'vaccine_due' then 40 when 'review_due' then 20
                                      when 'report_ready' then 5 when 'reminder' then 5 when 'grooming_due' then 10
                                      when 'bath_due' then 12 when 'haircut_due' then 8 when 'consult_followup' then 15
                                      when 'new_pet' then 10 when 'rabies_course' then 10 when 'vaccine_course' then 30 when 'deworm_due' then 10 when 'tick_recheck' then 8 when 'sibling_vaccine' then 10 when 'birthday' then 10 when 'senior_check' then 10 when 'vaccine_never' then 10 when 'boarding_holiday' then 15 when 'sub_due' then 15 when 'sub_expiring' then 15 when 'sub_renew' then 10 when 'multi_pet' then 15 when 'followup' then 30 when 'churned' then 10 when 'lead' then 10 else 1 end,
                    t.rank, t.phone loop
    a := null;
    if capacity > 0 then
      select id into a from t_agent where n < target and (units = '{}' or r.unit = any (units))
       order by (units = '{}'), n::numeric / target, id limit 1;
      if a is null then
        if r.rank < 12 then dropped := dropped + 1; end if;
        -- not fitted today (capacity / units): waits as a follow-up with its priority - not lost
        insert into calldesk.followups (phone, due, reasons, why, from_list)
        values (r.phone, d + 1, (select coalesce(jsonb_agg(e), '[]') from jsonb_array_elements(r.reasons) e where e->>'type' not in ('callback', 'followup', 'checkin')), 'waiting', d)
        on conflict (phone) do nothing;
        continue;
      end if;
      update t_agent set n = n + 1 where id = a;
    elsif r.rank = 12 then
      continue;
    end if;
    insert into calldesk.queue (list_date, agent_id, phone, client, unit, rank, score, reasons, pets)
    values (d, a, r.phone, r.client, r.unit, r.rank, coalesce(r.score, 0), r.reasons, r.pets)
    on conflict (list_date, phone) do nothing;
  end loop;
  -- follow-ups now on a list leave the waiting list (the ones that did not fit wait for the next day)
  delete from calldesk.followups f where f.due <= d
     and exists (select 1 from calldesk.queue q where q.list_date = d and q.phone = f.phone and q.agent_id is not null);
  for r in select q.id, q.unit from calldesk.queue q
           where q.list_date = d and (q.agent_id is null or q.agent_id not in (select id from t_agent)
                  or not exists (select 1 from t_agent ta where ta.id = q.agent_id and (ta.units = '{}' or q.unit = any (ta.units)))) loop
    select id into a from t_agent where (units = '{}' or r.unit = any (units)) order by n::numeric / target, id limit 1;
    if a is null then update calldesk.queue set agent_id = null where id = r.id; continue; end if;
    update calldesk.queue set agent_id = a where id = r.id;
    update t_agent set n = n + 1 where id = a;
  end loop;
  perform calldesk.balance_lists(d);   -- every agent exactly their target (200) of VISIBLE calls, within their units
  perform calldesk.balance_lists(d);   -- second pass: trims anyone left over target, tops up anyone short
  -- (16 Nov 2026) no copy of the bills any more: cd_bills reads vetbuddy.sales directly
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
end $function$
;
