-- live definition of calldesk.cf_live_dedupe() - exported from the database
CREATE OR REPLACE FUNCTION calldesk.cf_live_dedupe()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.source = 'Corefactor' and new.call_key not like 'live:%' then
    delete from calldesk.calls
     where source = 'Corefactor' and call_key like 'live:%' and phone = new.phone
       and call_at between new.call_at - interval '3 minutes' and new.call_at + interval '3 minutes';
  end if;
  return null;
end $function$
;
