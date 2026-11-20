-- live definition of calldesk.incentive_next(p_dept text, p_visits integer) - exported from the database
CREATE OR REPLACE FUNCTION calldesk.incentive_next(p_dept text, p_visits integer)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'calldesk', 'public'
AS $function$
  select jsonb_build_object('at', s.from_visits, 'more', s.from_visits - p_visits, 'per_visit', s.per_visit)
    from calldesk.incentive_slabs s where s.department = p_dept and s.from_visits > p_visits order by s.from_visits limit 1
$function$
;
