-- live definition of public.cd_alert_ack(p_card bigint) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_alert_ack(p_card bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare m calldesk.agents := calldesk.me();
begin
  if m.id is null or m.role <> 'lead' then raise exception 'not allowed' using errcode = '42501'; end if;
  update calldesk.card_time set acked_at = now(), acked_by = m.email where id = p_card;
end $function$
;
