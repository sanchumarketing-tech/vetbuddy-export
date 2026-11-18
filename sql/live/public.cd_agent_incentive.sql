-- live definition of public.cd_agent_incentive(p_id integer, p_logins text[], p_target integer) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_agent_incentive(p_id integer, p_logins text[], p_target integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare m calldesk.agents := calldesk.me();
begin
  if m.role is distinct from 'lead' then raise exception 'not allowed' using errcode = '42501'; end if;
  update calldesk.agents set vb_logins = coalesce((select array_agg(distinct trim(x)) from unnest(p_logins) x where trim(x) <> ''), '{}'),
                             appt_target = p_target
   where id = p_id;
end $function$
;
