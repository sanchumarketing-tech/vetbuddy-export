-- live definition of calldesk.deceased_hit(p_phone text, e jsonb) - exported from the database
CREATE OR REPLACE FUNCTION calldesk.deceased_hit(p_phone text, e jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
  select exists (select 1 from calldesk.deceased_map m where m.phone = p_phone and m.all_dead)
      or (e ? 'pet_id' and exists (select 1 from calldesk.deceased_pets x where x.pet_id = e->>'pet_id'))
      or (not e ? 'pet_id' and coalesce(e->>'pet', e->>'name', '') <> '' and exists (
            select 1 from regexp_split_to_table(coalesce(e->>'pet', e->>'name'), '\s*,\s*') t(tok)
             where exists (select 1 from calldesk.deceased_pets x where x.pet_id = substring(t.tok from '\((\d+)\)'))
                or exists (select 1 from calldesk.deceased_map m where m.phone = p_phone
                              and m.pet_lc = lower(trim(regexp_replace(t.tok, '\s*\(\d+\).*$', ''))))))
$function$
;
