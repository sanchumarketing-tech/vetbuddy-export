-- live definition of calldesk.omitted(p_phone text) - exported from the database
CREATE OR REPLACE FUNCTION calldesk.omitted(p_phone text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
  select exists (select 1 from calldesk.settings s
                  where s.key = 'skip_called' and (s.value->>'on')::boolean
                    and exists (select 1 from calldesk.calls k
                                 where k.phone = p_phone and k.source = coalesce(s.value->>'source', 'Corefactor')
                                   and k.call_at >= (s.value->>'from')::date::timestamp
                                   and k.call_at < ((s.value->>'to')::date + 1)::timestamp))
$function$
;
