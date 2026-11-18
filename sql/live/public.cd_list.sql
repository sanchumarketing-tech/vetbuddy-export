-- live definition of public.cd_list(p_day date, p_agent integer) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_list(p_day date DEFAULT NULL::date, p_agent integer DEFAULT '-1'::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare m calldesk.agents := calldesk.me(); who int;
begin
  if m.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  who := case when m.role = 'lead' then nullif(p_agent, -1) else m.id end;
  if m.role = 'lead' and p_agent = -1 then who := null; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', q.id, 'day', q.list_date, 'agent_id', q.agent_id, 'phone', q.phone, 'client', q.client, 'unit', q.unit,
             'rank', q.rank, 'reasons', calldesk.strip_off(q.reasons), 'pets', q.pets, 'tries', q.tries, 'carried_from', q.carried_from,
             'calls', q.call_count, 'attempted_at', q.attempted_at, 'connected_at', q.connected_at, 'last_call', q.last_call,
             'dialed_at', q.dialed_at, 'outcome', q.outcome, 'note', q.note, 'callback_at', q.callback_at,
             'status', calldesk.status_of(q), 'called_at', q.called_at, 'called_by', q.called_by, 'try_slot', q.try_slot, 'try_note', q.try_note, 'skipped_at', q.skipped_at)
           order by q.rank, q.score desc, q.id)
    from calldesk.queue q
    where q.list_date = coalesce(p_day, calldesk.today()) and calldesk.row_visible(q) and (m.role = 'lead' or m.units = '{}' or q.unit = any (m.units))
      and (who is null and m.role = 'lead' or q.agent_id = who or (who = 0 and q.agent_id is null))), '[]');
end $function$
;
