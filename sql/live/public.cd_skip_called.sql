-- live definition of public.cd_skip_called(p_on boolean) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_skip_called(p_on boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare m calldesk.agents := calldesk.me();
begin
  if m.role is distinct from 'lead' then raise exception 'not allowed' using errcode = '42501'; end if;
  update calldesk.settings set value = jsonb_set(value, '{on}', to_jsonb(p_on)), set_by = m.name, set_at = now() where key = 'skip_called';
  return (select value || jsonb_build_object('by', set_by, 'at', set_at) from calldesk.settings where key = 'skip_called');
end $function$
;
