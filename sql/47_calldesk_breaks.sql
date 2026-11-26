-- 26 Nov 2026: Break button for agents.
-- An agent starts a break: their open customer card is closed (so the 12-minute warning cannot fire), and the page locks
-- the list and the Call buttons until they end the break. Team leads see who is on break.
-- New table calldesk.agent_breaks + new function public.cd_break(p_action). Nothing existing is changed.
-- Also add "cd_break" to ALLOWED in calldesk/api/rpc.py.

create table if not exists calldesk.agent_breaks (
  id         bigserial primary key,
  agent_id   int not null,
  started_at timestamptz not null default now(),
  ended_at   timestamptz
);
create index if not exists agent_breaks_open on calldesk.agent_breaks (agent_id) where ended_at is null;
create index if not exists agent_breaks_day on calldesk.agent_breaks (started_at);
alter table calldesk.agent_breaks enable row level security;
revoke all on calldesk.agent_breaks from public, anon, authenticated;

-- p_action: 'status' (default) | 'start' | 'end'  (the signed-in agent)   |   'list' (team leads: who is on break now, minutes today)
create or replace function public.cd_break(p_action text default 'status')
 returns jsonb language plpgsql security definer set search_path to 'calldesk', 'public' as $$
declare m calldesk.agents := calldesk.me(); day0 timestamptz := (calldesk.today()::timestamp at time zone 'Asia/Kolkata');
begin
  if m.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  -- a break left open for more than 3 hours is a closed browser, not a break
  update calldesk.agent_breaks set ended_at = started_at + interval '3 hours' where ended_at is null and started_at < now() - interval '3 hours';
  if p_action = 'list' then
    if m.role <> 'lead' then raise exception 'not allowed' using errcode = '42501'; end if;
    return jsonb_build_object(
      'now', coalesce((select jsonb_agg(jsonb_build_object('agent_id', b.agent_id, 'agent', a.name,
                 'since', to_char(b.started_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI:SS'),
                 'minutes', floor(extract(epoch from now() - b.started_at) / 60)::int) order by b.started_at)
               from calldesk.agent_breaks b join calldesk.agents a on a.id = b.agent_id where b.ended_at is null), '[]'::jsonb),
      'today', coalesce((select jsonb_object_agg(x.agent_id::text, jsonb_build_object('n', x.n, 'minutes', x.mins)) from (
                 select agent_id, count(*) n, round(sum(extract(epoch from coalesce(ended_at, now()) - started_at)) / 60)::int mins
                   from calldesk.agent_breaks where started_at >= day0 group by 1) x), '{}'::jsonb));
  end if;
  if p_action = 'start' and not exists (select 1 from calldesk.agent_breaks where agent_id = m.id and ended_at is null) then
    update calldesk.card_time set closed_at = now() where agent_id = m.id and closed_at is null;   -- no 12-minute warning during a break
    insert into calldesk.agent_breaks (agent_id) values (m.id);
  elsif p_action = 'end' then
    update calldesk.agent_breaks set ended_at = now() where agent_id = m.id and ended_at is null;
  end if;
  return (select jsonb_build_object(
      'on_break', exists (select 1 from calldesk.agent_breaks where agent_id = m.id and ended_at is null),
      'since', (select to_char(started_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI:SS') from calldesk.agent_breaks where agent_id = m.id and ended_at is null limit 1),
      'today_minutes', coalesce((select round(sum(extract(epoch from coalesce(ended_at, now()) - started_at)) / 60)::int
                                   from calldesk.agent_breaks where agent_id = m.id and started_at >= day0), 0),
      'today_breaks', (select count(*) from calldesk.agent_breaks where agent_id = m.id and started_at >= day0)));
end $$;
revoke all on function public.cd_break(text) from public;
grant execute on function public.cd_break(text) to anon, authenticated;
