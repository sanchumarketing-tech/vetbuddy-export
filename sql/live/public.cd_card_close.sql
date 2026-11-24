-- live definition of public.cd_card_close(p_card bigint) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_card_close(p_card bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare m calldesk.agents := calldesk.me();
begin
  if m.id is null then return; end if;
  update calldesk.card_time set closed_at = now() where id = p_card and agent_id = m.id and closed_at is null;
end $function$
;
