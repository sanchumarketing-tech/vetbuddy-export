-- live definition of public.cd_agent_calls(p_from date, p_to date) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_agent_calls(p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare m calldesk.agents := calldesk.me(); f date := coalesce(p_from, calldesk.today()); t date := coalesce(p_to, p_from, calldesk.today());
begin
  if m.role is distinct from 'lead' then raise exception 'not allowed' using errcode = '42501'; end if;
  if t < f then t := f; end if;
  if t - f > 30 then raise exception 'Pick 31 days or fewer.' using errcode = '22023'; end if;
  return jsonb_build_object(
    'from', f, 'to', t,
    'loaded_to', (select to_char(max(call_at), 'YYYY-MM-DD"T"HH24:MI:SS') from calldesk.calls where call_at < t + 1),
    'calls', coalesce((select jsonb_agg(jsonb_build_array(
        k.agent, to_char(k.call_at, 'YYYY-MM-DD"T"HH24:MI:SS'), k.direction, k.answered, coalesce(k.duration_s, 0), k.talk_s, k.status, k.source,
        k.direction = 'out' and not exists (select 1 from calldesk.calls p where p.phone = k.phone and p.direction = 'out' and p.call_at < k.call_at),
        k.phone) order by k.agent, k.call_at)
      from calldesk.calls k
     where k.call_at >= f and k.call_at < t + 1 and coalesce(k.agent, '') <> ''), '[]'::jsonb),
    'cards', coalesce((select jsonb_agg(jsonb_build_array(
        a.name,
        to_char(c.opened_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI:SS'),
        to_char(coalesce(c.closed_at, least(now(), c.opened_at + interval '3 hours')) at time zone 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI:SS'),
        c.alerted_at is not null, c.closed_at is null, c.phone) order by a.name, c.opened_at)
      from calldesk.card_time c join calldesk.agents a on a.id = c.agent_id
     where c.opened_at >= (f::timestamp at time zone 'Asia/Kolkata') and c.opened_at < ((t + 1)::timestamp at time zone 'Asia/Kolkata')), '[]'::jsonb));
end $function$
;
