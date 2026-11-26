-- live definition of public.cd_booking_repeats(p_month date, p_agent integer, p_min integer) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_booking_repeats(p_month date DEFAULT NULL::date, p_agent integer DEFAULT '-1'::integer, p_min integer DEFAULT 5)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare m calldesk.agents := calldesk.me(); f date; t date;
  pm date := date_trunc('month', coalesce(p_month,
               case when extract(day from calldesk.today()) >= 21 then (calldesk.today() + interval '1 month')::date else calldesk.today() end))::date;
begin
  if m.role is distinct from 'lead' then raise exception 'not allowed' using errcode = '42501'; end if;
  f := (pm - interval '1 month' + interval '20 days')::date;
  t := (pm + interval '20 days')::date;
  return (
  with lg as materialized (select g.id agent_id, lower(x) login from calldesk.agents g, unnest(g.vb_logins) x
                            where g.role = 'agent' and (p_agent = -1 or g.id = p_agent)),
  ba as materialized (select lg.agent_id, ap.* from calldesk.appointments ap join lg on lg.login = lower(ap.created_by)
                       where ap.appt_date >= f and ap.appt_date < t and ap.pet_id is not null),
  pp as (select agent_id, pet_id, count(*) n from ba group by 1, 2),
  per as (select agent_id, sum(n) appts, count(*) pets, count(*) filter (where n >= p_min) rep_pets,
                 coalesce(sum(n) filter (where n >= p_min), 0) rep_appts, max(n) max_n from pp group by 1)
  select jsonb_build_object('month', pm, 'cycle_from', f, 'cycle_to', t - 1, 'min', p_min,
    'agents', coalesce((select jsonb_object_agg(agent_id::text, jsonb_build_object('appts', appts, 'pets', pets, 'rep_pets', rep_pets,
                'rep_appts', rep_appts, 'max', max_n)) from per), '{}'::jsonb),
    'repeats', case when p_agent <> -1 then coalesce((select jsonb_agg(jsonb_build_object(
        'pet_id', b.pet_id, 'pet', regexp_replace(coalesce(b.pet, ''), '\s*\(\d+\).*$', ''), 'client', b.client, 'phone', b.phone,
        'n', pp.n, 'appt_id', b.appt_id, 'appt_date', b.appt_date, 'appt_time', b.appt_time,
        'booked_at', to_char(b.created_at, 'YYYY-MM-DD"T"HH24:MI:SS'), 'type', b.appt_type, 'status', b.status,
        'clinic', b.clinic, 'login', b.created_by, 'cancel_reason', b.cancel_reason)
        order by pp.n desc, b.pet_id, b.appt_date, b.created_at, b.appt_id)
      from ba b join pp using (agent_id, pet_id) where pp.n >= p_min), '[]'::jsonb) else '[]'::jsonb end));
end $function$
;
