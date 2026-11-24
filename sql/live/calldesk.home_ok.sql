-- live definition of calldesk.home_ok(p_units text[], p_unit text, p_reasons jsonb) - exported from the database
CREATE OR REPLACE FUNCTION calldesk.home_ok(p_units text[], p_unit text, p_reasons jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
  -- 24 Nov 2026: a Vet on Wheels agent may call customers of its parent clinic(s) when a reason can be done at home
  select exists (select 1 from calldesk.vow_parent v where v.vow_unit = any (p_units) and v.clinic_unit = p_unit)
     and exists (select 1 from jsonb_array_elements(calldesk.strip_off(p_reasons)) e join calldesk.home_visit_reasons h on h.type = e->>'type')
$function$
;
