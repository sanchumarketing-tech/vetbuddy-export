-- live definition of calldesk.cf_live_lead_dedupe() - exported from the database
CREATE OR REPLACE FUNCTION calldesk.cf_live_lead_dedupe()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.lead_key not like 'live:%' then
    delete from calldesk.leads where lead_key like 'live:%' and phone = new.phone
       and created_at between new.created_at - interval '5 minutes' and new.created_at + interval '5 minutes';
  end if;
  return null;
end $function$
;
