-- live definition of public.cd_kpi(p_from date, p_to date) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_kpi(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare m calldesk.agents := calldesk.me();
begin
  if m.role is distinct from 'lead' then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((
    with r as materialized (
      select q.id, q.phone, q.list_date, q.attempted_at, q.connected_at, e->>'type' as type, (e->>'rank')::int as rank,
             q.list_date + case e->>'type' when 'churned' then 30 when 'new_pet' then 60 when 'appt_tomorrow' then 1
                                          when 'post_surgery' then 10 else 14 end as until
        from calldesk.queue q, jsonb_array_elements(q.reasons) e
       where q.list_date between p_from and p_to and not q.superseded),
    rc as materialized (
      select r.*, exists (
               select 1 from vetbuddy.sales s
                where calldesk.norm_phone(s.client_phone) = r.phone and s.sale_date between r.list_date and r.until
                  and (r.type <> 'reminder' or s.plan_category ilike 'vaccination%' or s.plan_subcategory ilike any (array['%consult%', '%review%']))
                  and (r.type <> 'bath_due' or s.plan_subcategory ilike 'bathing')
                  and (r.type <> 'haircut_due' or s.plan_subcategory ilike 'haircut')
                  and (r.type <> 'post_surgery' or s.plan_subcategory ilike any (array['%consult%', '%review%']))) as conv
        from r)
    select jsonb_agg(z order by z.rank) from (
      select type, min(rank) rank, count(*) due,
             count(*) filter (where attempted_at is not null) attempted,
             count(*) filter (where connected_at is not null) connected,
             count(*) filter (where conv) converted,
             count(*) filter (where conv and connected_at is not null) converted_after_call
        from rc group by type) z), '[]');
end $function$
;
