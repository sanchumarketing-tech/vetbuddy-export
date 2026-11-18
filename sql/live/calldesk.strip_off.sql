-- live definition of calldesk.strip_off(p jsonb) - exported from the database
CREATE OR REPLACE FUNCTION calldesk.strip_off(p jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
  select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements(coalesce(p, '[]'::jsonb)) e
   where e->>'type' = 'callback' or not exists (select 1 from calldesk.reason_off o where o.type = e->>'type')
$function$
;
