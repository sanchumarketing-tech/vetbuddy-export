-- live definition of calldesk.cf_live_mark() - exported from the database
CREATE OR REPLACE FUNCTION calldesk.cf_live_mark()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
-- 24 Nov 2026: a live Corefactor push marks the customer's list rows at once (same fields as refresh_status)
begin
  if coalesce(new.direction, 'out') <> 'in' and new.call_key like 'live:%' then
    update calldesk.queue q
       set call_count = coalesce(q.call_count, 0) + 1,
           attempted_at = least(coalesce(q.attempted_at, new.call_at), new.call_at),
           connected_at = case when new.answered then least(coalesce(q.connected_at, new.call_at), new.call_at) else q.connected_at end,
           last_call = new.source || ' ' || to_char(new.call_at, 'DD Mon HH24:MI') || ' ' || coalesce(nullif(new.status, ''), case when new.answered then 'answered' else 'not answered' end)
     where q.phone = new.phone and q.list_date between new.call_at::date - 14 and new.call_at::date and not q.superseded;
  end if;
  return new;
end $function$
;
