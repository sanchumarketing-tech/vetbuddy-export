-- live definition of public.cd_assign(p_ids bigint[], p_agent integer) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_assign(p_ids bigint[], p_agent integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare m calldesk.agents := calldesk.me(); n int;
begin
  if m.role is distinct from 'lead' then raise exception 'not allowed' using errcode = '42501'; end if;
  update calldesk.queue set agent_id = p_agent, updated_at = now() where id = any (p_ids);
  get diagnostics n = row_count;
  return n;
end $function$
;
