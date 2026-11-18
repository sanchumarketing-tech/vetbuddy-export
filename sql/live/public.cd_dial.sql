-- live definition of public.cd_dial(p_id bigint) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_dial(p_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare m calldesk.agents := calldesk.me();
begin
  update calldesk.queue set dialed_at = now(), updated_at = now()
   where id = p_id and (agent_id = m.id or m.role = 'lead');
  if not found then raise exception 'not allowed' using errcode = '42501'; end if;
end $function$
;
