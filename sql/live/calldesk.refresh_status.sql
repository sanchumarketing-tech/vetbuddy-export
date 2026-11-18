-- live definition of calldesk.refresh_status(p_from date) - exported from the database
CREATE OR REPLACE FUNCTION calldesk.refresh_status(p_from date DEFAULT NULL::date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare n int;
begin
  with c as (
    select q.id,
           count(k.*)                                         as cnt,
           min(k.call_at)                                     as first_at,
           min(k.call_at) filter (where k.answered)           as conn_at,
           (array_agg(k.source || ' ' || to_char(k.call_at, 'DD Mon HH24:MI') || ' ' ||
                      coalesce(nullif(k.status, ''), case when k.answered then 'answered' else 'not answered' end) ||
                      coalesce(' - ' || nullif(k.agent, ''), '') order by k.call_at desc))[1] as last_call
    from calldesk.queue q
    join calldesk.calls k on k.phone = q.phone and k.call_at >= q.list_date::timestamp
                          and coalesce(k.direction, 'out') <> 'in'
    where q.list_date >= coalesce(p_from, calldesk.today() - 14) and not q.superseded
    group by q.id)
  update calldesk.queue q
     set call_count = c.cnt, attempted_at = c.first_at, connected_at = c.conn_at, last_call = c.last_call
    from c where c.id = q.id
      and (q.call_count, q.attempted_at, q.connected_at) is distinct from (c.cnt, c.first_at, c.conn_at);
  get diagnostics n = row_count;
  return n;
end $function$
;
