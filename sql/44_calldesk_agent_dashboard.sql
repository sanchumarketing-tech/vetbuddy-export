-- 26 Nov 2026: Agent logs -> Dashboard (team leads). Same rules as the "Agent Wise - MIS" Google Sheet
-- (breaks, RNR splits, calling / talk time, hourly, new leads), worked out in the page from the calls below,
-- plus the time agents spent on customer cards (calldesk.card_time).
-- Read-only. Nothing existing is changed. Also add "cd_agent_calls" to ALLOWED in calldesk/api/rpc.py.
--
-- Corefactor webhook calls carry the agent's NUMBER. The page learns number -> agent from customer cards: an agent opens a
-- customer, and a call from that number to the customer's phone follows (99-100% consistent on 19-26 Nov 2026).
-- calls: [agent, call_at (IST), direction, answered, duration_s, talk_s, status, source, new_lead, phone]
--   new_lead = the first outbound call ever made to that number in calldesk.calls
-- cards: [agent, opened (IST), closed (IST), warned (12+ min), still_open, customer phone]

create or replace function public.cd_agent_calls(p_from date default null, p_to date default null)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'calldesk', 'public'
as $function$
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
end $function$;

revoke all on function public.cd_agent_calls(date, date) from public;
grant execute on function public.cd_agent_calls(date, date) to anon, authenticated;
