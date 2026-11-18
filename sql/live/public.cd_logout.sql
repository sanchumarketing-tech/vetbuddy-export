-- live definition of public.cd_logout() - exported from the database
CREATE OR REPLACE FUNCTION public.cd_logout()
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
  delete from calldesk.sessions
   where token = nullif(coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json ->> 'x-cd-token', '')
$function$
;
