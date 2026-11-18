-- live definition of calldesk.status_of(q calldesk.queue) - exported from the database
CREATE OR REPLACE FUNCTION calldesk.status_of(q calldesk.queue)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case
    when q.outcome in ('booked', 'will_visit', 'not_interested', 'wrong_number', 'dnd', 'deceased') then 'closed'
    when q.outcome = 'callback' and q.connected_at is null then 'callback'
    when q.connected_at is not null then 'connected'
    when q.attempted_at is not null then 'attempted'
    else 'new' end
$function$
;
