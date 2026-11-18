-- live definition of public.cd_reason_set(p_type text, p_on boolean) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_reason_set(p_type text, p_on boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare m calldesk.agents := calldesk.me();
begin
  if m.role is distinct from 'lead' then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_type is null or p_type = 'callback' then raise exception 'this reason cannot be switched off'; end if;
  if p_on then delete from calldesk.reason_off where type = p_type;
  else insert into calldesk.reason_off (type, off_by) values (p_type, m.name) on conflict (type) do nothing; end if;
  return coalesce((select jsonb_agg(type order by type) from calldesk.reason_off), '[]');
end $function$
;
