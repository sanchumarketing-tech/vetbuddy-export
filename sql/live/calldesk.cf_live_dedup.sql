-- live definition of calldesk.cf_live_dedup(p_from date, p_to date) - exported from the database
CREATE OR REPLACE FUNCTION calldesk.cf_live_dedup(p_from date, p_to date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
-- 24 Nov 2026: once the Corefactor export of a day is loaded, the live webhook copy of the same call goes
-- (same phone, start within 2 minutes). Live calls the export does not have are kept.
declare n int;
begin
  delete from calldesk.calls l
   where l.source = 'Corefactor' and l.call_key like 'live:%'
     and l.call_at >= p_from::timestamp and l.call_at < (p_to + 1)::timestamp
     and exists (select 1 from calldesk.calls e
                  where e.source = 'Corefactor' and e.call_key not like 'live:%' and e.phone = l.phone
                    and e.call_at between l.call_at - interval '2 minutes' and l.call_at + interval '2 minutes');
  get diagnostics n = row_count;
  return n;
end $function$
;
