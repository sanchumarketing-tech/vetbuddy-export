-- live definition of public.cd_agent_logs(p_day date) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_agent_logs(p_day date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
-- 24 Nov 2026: 12-minute warnings (one customer card open too long), for team leads
declare m calldesk.agents := calldesk.me(); d date := coalesce(p_day, calldesk.today());
begin
  if m.role is distinct from 'lead' then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object('day', d, 'rows', coalesce((select jsonb_agg(jsonb_build_object(
      'id', c.id, 'agent', a.name, 'client', c.client, 'phone', c.phone,
      'opened_at', to_char(c.opened_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI:SS'),
      'closed_at', to_char(c.closed_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI:SS'),
      'alerted_at', to_char(c.alerted_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI:SS'),
      'minutes', round(extract(epoch from (coalesce(c.closed_at, now()) - c.opened_at)) / 60.0, 1),
      'open', c.closed_at is null, 'acked_by', c.acked_by,
      'acked_at', to_char(c.acked_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI:SS')) order by c.opened_at desc)
    from calldesk.card_time c left join calldesk.agents a on a.id = c.agent_id
   where c.alerted_at is not null and (c.opened_at at time zone 'Asia/Kolkata')::date = d), '[]'::jsonb),
   'summary', coalesce((select jsonb_agg(jsonb_build_object('agent', s.name, 'warnings', s.n, 'minutes', s.mins) order by s.n desc) from (
      select a.name, count(*) n, round(sum(extract(epoch from (coalesce(c.closed_at, now()) - c.opened_at)) / 60.0)) mins
        from calldesk.card_time c left join calldesk.agents a on a.id = c.agent_id
       where c.alerted_at is not null and (c.opened_at at time zone 'Asia/Kolkata')::date = d group by a.name) s), '[]'::jsonb));
end $function$
;
