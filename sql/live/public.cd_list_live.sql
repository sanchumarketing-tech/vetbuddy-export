-- live definition of public.cd_list_live(p_day date, p_agent integer, p_since timestamp with time zone) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_list_live(p_day date DEFAULT NULL::date, p_agent integer DEFAULT '-1'::integer, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
-- 24 Nov 2026: only the list rows a Corefactor call changed since p_since (small, for the 30-second check)
declare m calldesk.agents := calldesk.me(); who int; d date := coalesce(p_day, calldesk.today());
begin
  if m.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  who := case when m.role = 'lead' then nullif(p_agent, -1) else m.id end;
  return jsonb_build_object('now', now(), 'rows', coalesce((
    select jsonb_agg(jsonb_build_object('id', q.id, 'calls', q.call_count, 'attempted_at', q.attempted_at, 'connected_at', q.connected_at,
                                        'last_call', q.last_call, 'status', calldesk.status_of(q)))
      from calldesk.queue q
     where q.list_date = d and q.cf_at > coalesce(p_since, now() - interval '2 minutes')
       and (m.role = 'lead' or m.units = '{}' or q.unit = any (m.units) or q.agent_id = m.id)
       and (who is null and m.role = 'lead' or q.agent_id = who or (who = 0 and q.agent_id is null))), '[]'::jsonb));
end $function$
;
