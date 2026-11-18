-- live definition of calldesk.visible_ids(p_from date, p_to date) - exported from the database
CREATE OR REPLACE FUNCTION calldesk.visible_ids(p_from date, p_to date)
 RETURNS TABLE(id bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
  -- the same rule as row_visible, for many rows at once (fast): a switched-on reason, not omitted, not called the day before
  with off as (select coalesce(array_agg(type), '{}') t from calldesk.reason_off),
  sw as (select coalesce((value->>'on')::boolean, false) on_, (value->>'from')::date f, (value->>'to')::date t2,
                coalesce(value->>'source', 'Corefactor') src from calldesk.settings where key = 'skip_called'),
  q as (select q.id, q.phone, q.list_date, q.outcome, q.called_at, q.reasons from calldesk.queue q where q.list_date between p_from and p_to),
  om as (select distinct k.phone from calldesk.calls k, sw
          where sw.on_ and k.source = sw.src and k.call_at >= sw.f::timestamp and k.call_at < (sw.t2 + 1)::timestamp),
  cy as (select distinct k.phone, (k.call_at::date + 1) d from calldesk.calls k
          where k.direction = 'out' and k.call_at >= (p_from - 1)::timestamp and k.call_at < p_to::timestamp
         union
         select y.phone, ((y.called_at at time zone 'Asia/Kolkata')::date + 1) from calldesk.queue y
          where y.list_date between p_from - 8 and p_to
            and y.called_at >= ((p_from - 1)::timestamp at time zone 'Asia/Kolkata') and y.called_at < (p_to::timestamp at time zone 'Asia/Kolkata'))
  select q.id from q, off
   where exists (select 1 from jsonb_array_elements(q.reasons) e where e->>'type' = 'callback' or not (e->>'type' = any (off.t)))
     and (q.outcome = 'callback' or not exists (select 1 from om where om.phone = q.phone))
     and (q.outcome = 'callback' or q.called_at is not null or not exists (select 1 from cy where cy.phone = q.phone and cy.d = q.list_date))
$function$
;
