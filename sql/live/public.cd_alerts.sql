-- live definition of public.cd_alerts() - exported from the database
CREATE OR REPLACE FUNCTION public.cd_alerts()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare m calldesk.agents := calldesk.me(); res jsonb;
begin
  if m.id is null or m.role <> 'lead' then raise exception 'not allowed' using errcode = '42501'; end if;
  update calldesk.card_time set closed_at = opened_at + interval '3 hours' where closed_at is null and opened_at < now() - interval '3 hours';
  update calldesk.card_time set alerted_at = now()
   where closed_at is null and acked_at is null and alerted_at is null and opened_at <= now() - interval '12 minutes';
  select coalesce(jsonb_agg(jsonb_build_object('card', c.id, 'agent', a.name, 'client', c.client, 'phone', c.phone,
           'opened_at', c.opened_at, 'minutes', floor(extract(epoch from now() - c.opened_at) / 60)::int) order by c.opened_at), '[]')
    into res
    from calldesk.card_time c join calldesk.agents a on a.id = c.agent_id
   where c.closed_at is null and c.acked_at is null and c.opened_at <= now() - interval '12 minutes';
  return res;
end $function$
;
