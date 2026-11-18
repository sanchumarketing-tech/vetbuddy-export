-- live definition of public.cd_me() - exported from the database
CREATE OR REPLACE FUNCTION public.cd_me()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
  select case when m.id is null then null
         else jsonb_build_object('id', m.id, 'name', m.name, 'email', m.email, 'role', m.role, 'units', m.units,
                                 'target', m.daily_target, 'today', calldesk.today()) end
  from calldesk.me() m
$function$
;
