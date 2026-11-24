-- live definition of public.cd_card_open(p_id bigint) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_card_open(p_id bigint)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare m calldesk.agents := calldesk.me(); q calldesk.queue; nid bigint;
begin
  if m.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  update calldesk.card_time set closed_at = now() where agent_id = m.id and closed_at is null;
  select * into q from calldesk.queue where id = p_id and agent_id = m.id;
  if q.id is null then return null; end if;
  insert into calldesk.card_time (queue_id, agent_id, phone, client) values (q.id, m.id, q.phone, q.client) returning id into nid;
  return nid;
end $function$
;
