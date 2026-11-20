-- live definition of public.cd_team(p_day date) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_team(p_day date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare m calldesk.agents := calldesk.me(); d date := coalesce(p_day, calldesk.today()); res jsonb;
begin
  if m.role is distinct from 'lead' then raise exception 'not allowed' using errcode = '42501'; end if;
  -- visibility is worked out once per row (switched-off reasons, omitted Corefactor numbers)
  with off as (select coalesce(array_agg(type), '{}') t from calldesk.reason_off),
  sw as (select coalesce((value->>'on')::boolean, false) as on_, (value->>'from')::date f, (value->>'to')::date t2,
                coalesce(value->>'source', 'Corefactor') src from calldesk.settings where key = 'skip_called'),
  q0 as (select q.*, exists (select 1 from jsonb_array_elements(q.reasons) e, off where e->>'type' = 'callback' or not (e->>'type' = any (off.t))) as has_reason
           from calldesk.queue q where q.list_date = d),
  q as (select q0.*, q0.has_reason and (q0.outcome = 'callback' or not coalesce((select sw.on_ and exists (
                  select 1 from calldesk.calls k where k.phone = q0.phone and k.source = sw.src
                     and k.call_at >= sw.f::timestamp and k.call_at < (sw.t2 + 1)::timestamp) from sw), false)) and (q0.outcome = 'callback' or q0.called_at is not null or not calldesk.called_on(q0.phone, d - 1)) as vis
          from q0),
  v as (select * from q where vis)
  select jsonb_build_object('day', d, 'departments', (select jsonb_agg(jsonb_build_object('name', name, 'calls', calls) order by sort, name) from calldesk.departments),
    'agents', coalesce((select jsonb_agg(x order by x.name) from (
      select a.id, a.name, a.email, a.role, a.units, a.daily_target target, a.active, a.pin_hash is not null as has_pin, a.department, coalesce((select dp.calls from calldesk.departments dp where dp.name = a.department), false) as calls,
             count(v.id) assigned,
             count(v.id) filter (where v.attempted_at is not null) attempted,
             count(v.id) filter (where v.connected_at is not null) connected,
             count(v.id) filter (where v.outcome = 'booked') booked,
             count(v.id) filter (where v.outcome = 'callback') callbacks,
             count(v.id) filter (where v.dialed_at is not null) dialed, count(v.id) filter (where v.called_at is not null) marked_called,
             count(v.id) filter (where v.outcome = 'callback') rescheduled,
             count(v.id) filter (where v.rank < 12) must_call
        from calldesk.agents a left join v on v.agent_id = a.id
       group by a.id) x), '[]'),
    'unassigned', (select count(*) from v where v.agent_id is null),
    'skip_called', (select value || jsonb_build_object('by', set_by, 'at', set_at) from calldesk.settings where key = 'skip_called'),
    'hidden_called', (select count(*) from q where q.has_reason and not q.vis),
    'by_reason', (select coalesce(jsonb_agg(z order by z.rank), '[]') from (
        select e->>'type' type, min((e->>'rank')::int) rank, count(*) due,
               count(*) filter (where v.attempted_at is not null) attempted,
               count(*) filter (where v.connected_at is not null) connected
          from v, jsonb_array_elements(v.reasons) e group by 1) z),
    'reasons_off', (select coalesce(jsonb_agg(jsonb_build_object('type', type, 'by', off_by, 'at', off_at) order by type), '[]') from calldesk.reason_off),
    'last_call_loaded', (select max(call_at) from calldesk.calls))
  into res;
  return res;
end $function$
;
