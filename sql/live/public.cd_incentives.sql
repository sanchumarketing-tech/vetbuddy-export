-- live definition of public.cd_incentives(p_month date, p_agent integer, p_dept text) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_incentives(p_month date DEFAULT NULL::date, p_agent integer DEFAULT '-1'::integer, p_dept text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare m calldesk.agents := calldesk.me(); f date; t date;
  pm date := date_trunc('month', coalesce(p_month,
               case when extract(day from calldesk.today()) >= 21 then (calldesk.today() + interval '1 month')::date else calldesk.today() end))::date;
begin
  if m.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  f := (pm - interval '1 month' + interval '20 days')::date;   -- 21st of the previous month
  t := (pm + interval '20 days')::date;                         -- up to the 20th (exclusive 21st)
  return (
  with lg as materialized (select g.id agent_id, g.name, lower(x) login from calldesk.agents g, unnest(g.vb_logins) x where g.role = 'agent'),
  -- every booking by a mapped agent login with the appointment in the salary month
  ba as materialized (select lg.agent_id, lg.name agent_name, ap.pet_id, ap.appt_id, ap.appt_date, ap.appt_time,
                ap.status, ap.client, ap.pet, ap.phone, ap.clinic, ap.created_by
           from calldesk.appointments ap join lg on lg.login = lower(ap.created_by)
          where ap.appt_date >= f and ap.appt_date < t and ap.pet_id is not null),
  -- one per pet per agent (the earliest appointment)
  bk as materialized (select distinct on (agent_id, pet_id) * from ba order by agent_id, pet_id, appt_date, appt_id),
  -- shared: the same pet booked by two or more agents for the same appointment date
  sh as materialized (select pet_id, appt_date, array_agg(distinct agent_name) names from ba group by 1, 2 having count(distinct agent_id) > 1),
  sv as materialized (select distinct substring(s.client_id from '\(([^)]*)\)') pid, s.sale_date from vetbuddy.mv_pbi_pet_day s
          where s.sale_date >= f and s.sale_date < t + 4),
  vv as materialized (select b.agent_id, b.pet_id, min(sv.sale_date) visit_date from bk b join sv on sv.pid = b.pet_id and sv.sale_date between b.appt_date and b.appt_date + 3 group by 1, 2),
  rows as materialized (select b.*, vv.visit_date, sh.pet_id is not null shared, array_to_string(array_remove(sh.names, b.agent_name), ', ') shared_with
             from bk b left join vv using (agent_id, pet_id) left join sh on sh.pet_id = b.pet_id and sh.appt_date = b.appt_date),
  per as (select agent_id, count(*) booked, count(*) filter (where visit_date is not null) visited, count(*) filter (where shared) shared,
                 count(*) filter (where visit_date is not null and not shared) eligible from rows group by 1),
  ag as materialized (select a.* from calldesk.agents a
          where a.role = 'agent' and (m.role = 'lead' and (p_agent = -1 or a.id = p_agent) or a.id = m.id) and (coalesce(p_dept, '') = '' or p_agent <> -1 or m.role <> 'lead' or a.department = p_dept)),
  cl as (select k.agent, count(distinct k.phone) called
           from calldesk.calls k where k.direction = 'out' and k.call_at >= f and k.call_at < t and k.agent in (select name from ag) group by 1),
  mk as (select q.agent_id, count(*) marked from calldesk.queue q where q.called_at >= f and q.called_at < t group by 1)
  select jsonb_build_object('month', pm, 'department', p_dept, 'departments', (select jsonb_agg(name order by sort, name) from calldesk.departments), 'cycle_from', f, 'cycle_to', t - 1, 'agents', coalesce((select jsonb_agg(x order by x.eligible desc, x.name) from (
      select g.id, g.name, g.department, g.appt_target target, g.vb_logins logins, g.units,
             coalesce(cl.called, 0) called, coalesce(mk.marked, 0) marked_called,
             coalesce(per.booked, 0) booked, coalesce(per.visited, 0) visited, coalesce(per.shared, 0) shared, coalesce(per.eligible, 0) eligible
        from ag g left join cl on cl.agent = g.name left join mk on mk.agent_id = g.id left join per on per.agent_id = g.id
       where g.active or coalesce(cl.called, 0) > 0 or coalesce(per.booked, 0) > 0) x), '[]'),
    'rows', case when p_agent <> -1 or m.role <> 'lead' then coalesce((select jsonb_agg(jsonb_build_object(
              'agent_id', r.agent_id, 'appt_id', r.appt_id, 'appt_time', r.appt_time, 'appt_date', r.appt_date, 'status', r.status,
              'client', r.client, 'pet', regexp_replace(coalesce(r.pet, ''), '\s*\(\d+\).*$', ''), 'pet_id', r.pet_id, 'phone', r.phone, 'clinic', r.clinic,
              'login', r.created_by, 'visit_date', r.visit_date, 'shared', r.shared, 'shared_with', r.shared_with,
              'eligible', r.visit_date is not null and not r.shared) order by r.appt_date desc, r.appt_id)
             from rows r where r.agent_id in (select id from ag)), '[]') else '[]' end,
    'appts_from', (select min(appt_date) from calldesk.appointments),
    'unmapped_logins', case when m.role = 'lead' then (select coalesce(jsonb_agg(z order by z.n desc), '[]') from (
        select ap.created_by login, count(*) n from calldesk.appointments ap
         where ap.appt_date >= f and ap.appt_date < t and ap.created_by is not null and lower(ap.created_by) not in (select login from lg)
         group by 1 order by 2 desc limit 40) z) end));
end $function$
;
