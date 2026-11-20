-- live definition of calldesk.incentive_amount(p_dept text, p_visits integer) - exported from the database
CREATE OR REPLACE FUNCTION calldesk.incentive_amount(p_dept text, p_visits integer)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'calldesk', 'public'
AS $function$
  select coalesce((select s.fixed_amount + (p_visits - s.from_visits) * s.per_visit
                     from calldesk.incentive_slabs s where s.department = p_dept and s.from_visits <= p_visits
                    order by s.from_visits desc limit 1), 0)
$function$
;
