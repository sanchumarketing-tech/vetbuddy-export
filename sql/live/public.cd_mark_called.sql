-- live definition of public.cd_mark_called(p_id bigint) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_mark_called(p_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare m calldesk.agents := calldesk.me(); q calldesk.queue;
begin
  if m.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  update calldesk.queue
     set called_at = now(), called_by = m.name, updated_at = now(),
         outcome = case when outcome = 'callback' and callback_at <= now() then null else outcome end
   where id = p_id and (agent_id = m.id or m.role = 'lead')
  returning * into q;
  if q.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object('called_at', q.called_at, 'outcome', q.outcome, 'callback_at', q.callback_at);
end $function$
;
