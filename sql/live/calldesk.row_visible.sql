-- live definition of calldesk.row_visible(q calldesk.queue) - exported from the database
CREATE OR REPLACE FUNCTION calldesk.row_visible(q calldesk.queue)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
  select jsonb_array_length(calldesk.strip_off(calldesk.deceased_strip(q.phone, q.reasons))) > 0
     and (q.outcome = 'callback' or not calldesk.omitted(q.phone))
     and (q.outcome = 'callback' or q.called_at is not null or not calldesk.called_on(q.phone, q.list_date - 1))
$function$
;
