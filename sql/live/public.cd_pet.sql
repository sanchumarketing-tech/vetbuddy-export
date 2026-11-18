-- live definition of public.cd_pet(p_phone text, p_pet_id text) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_pet(p_phone text, p_pet_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare m calldesk.agents := calldesk.me();
begin
  if m.id is null or (m.role <> 'lead' and not exists (
       select 1 from calldesk.queue q where q.phone = p_phone and q.agent_id = m.id and q.list_date >= calldesk.today() - 30))
  then raise exception 'not allowed' using errcode = '42501'; end if;
  return (
    with s as (
      select s.* from vetbuddy.sales s
       where calldesk.norm_phone(s.client_phone) = p_phone and substring(s.client_id from '\(([^)]*)\)') = p_pet_id)
    select jsonb_build_object(
      'pet', (select jsonb_build_object('name', s.patient_name, 'species', s.species, 'breed', s.breed, 'sex', nullif(s.patient_gender, '---'),
                     'dob', case when s.patient_dob_text ~ '^[A-Z][a-z]{2}, \d{2} \d{4}$' then to_date(s.patient_dob_text, 'Mon, DD YYYY') end,
                     'weight', (select s2.patient_weight_kg from s s2 where nullif(s2.patient_weight_kg::text, '') is not null and s2.patient_weight_kg::text <> '0' order by s2.sale_date desc limit 1),
                     'parent', s.client_name)
                from s order by s.sale_date desc limit 1),
      'units', (select coalesce(jsonb_agg(x order by x.n desc), '[]') from (select s.sales_unit unit, bool_or(coalesce(s.is_vow, false)) vow, count(distinct s.sale_date) n, max(s.sale_date) last from s group by 1) x),
      'first', (select min(sale_date) from s), 'last', (select max(sale_date) from s),
      'visit_days', (select count(distinct sale_date) from s), 'spend', (select round(sum(amount)) from s),
      'vaccines', (select coalesce(jsonb_agg(x order by x.sale_date desc), '[]') from (
          select s.sale_date, regexp_replace(s.item_name, '^Vaccination & Physical Examination - ', '') item, s.sales_unit unit, s.doctor
            from s where (s.plan_category ilike 'vaccination%' or s.item_name ~* 'vaccin|nobivac') and s.item_name !~* 'advice') x),
      'deworming', (select coalesce(jsonb_agg(x order by x.sale_date desc), '[]') from (
          select s.sale_date, s.item_name item, s.sales_unit unit from s where s.item_name ~* 'deworm' and s.item_name !~* 'advice') x),
      'visits', (select coalesce(jsonb_agg(x order by x.sale_date desc), '[]') from (
          select s.sale_date, min(s.sales_unit) unit, string_agg(distinct s.doctor, ', ') doctor,
                 array_agg(s.item_name order by s.amount desc nulls last) items, round(sum(s.amount)) amount
            from s group by s.sale_date order by s.sale_date desc limit 30) x))
  );
end $function$
;
