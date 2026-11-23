-- live definition of calldesk.deceased_strip(p_phone text, p jsonb) - exported from the database
CREATE OR REPLACE FUNCTION calldesk.deceased_strip(p_phone text, p jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
  select case when not exists (select 1 from calldesk.deceased_map m where m.phone = p_phone) then coalesce(p, '[]'::jsonb)
         else coalesce((select jsonb_agg(e) from jsonb_array_elements(coalesce(p, '[]'::jsonb)) e
                         where not calldesk.deceased_hit(p_phone, e)), '[]'::jsonb) end
$function$
;
