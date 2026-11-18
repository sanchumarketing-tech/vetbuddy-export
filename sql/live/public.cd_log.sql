-- live definition of public.cd_log(p_from date, p_to date, p_agent integer) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_log(p_from date, p_to date, p_agent integer DEFAULT '-1'::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare m calldesk.agents := calldesk.me();
begin
  if m.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x order by x.list_date, x.agent, x.id) from (
    select q.id, q.list_date, coalesce(a.name, '(not assigned)') agent, q.client, q.phone, q.unit,
           (select string_agg(e->>'label', ' | ' order by (e->>'rank')::int) from jsonb_array_elements(calldesk.strip_off(q.reasons)) e) reasons,
           case when q.outcome = 'callback' and q.callback_at is not null then 'Rescheduled'
                when q.called_at is not null then 'Called' else 'Not called' end status,
           q.callback_at, q.called_at, q.called_by, q.note,
           q.attempted_at is not null logged_called, q.connected_at is not null logged_answered, q.last_call
      from calldesk.queue q left join calldesk.agents a on a.id = q.agent_id
     where q.list_date between p_from and p_to and not q.superseded and calldesk.row_visible(q)
       and (m.role = 'lead' and (p_agent = -1 or q.agent_id = p_agent) or q.agent_id = m.id)) x), '[]');
end $function$
;
