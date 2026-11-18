-- live definition of calldesk.called_on(p_phone text, p_day date) - exported from the database
CREATE OR REPLACE FUNCTION calldesk.called_on(p_phone text, p_day date)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
  -- an outgoing call that day (Corefactor / Runo log, answered or not) or marked "Called" in the app that day
  select exists (select 1 from calldesk.calls k where k.phone = p_phone and k.direction = 'out'
                  and k.call_at >= p_day::timestamp and k.call_at < (p_day + 1)::timestamp)
      or exists (select 1 from calldesk.queue y where y.phone = p_phone and y.list_date between p_day - 7 and p_day
                  and y.called_at >= (p_day::timestamp at time zone 'Asia/Kolkata') and y.called_at < ((p_day + 1)::timestamp at time zone 'Asia/Kolkata'))
$function$
;
