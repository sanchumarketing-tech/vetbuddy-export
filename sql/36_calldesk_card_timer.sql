-- 23 Nov 2026: time spent on each customer, and an alert to the team lead after 12 minutes on one customer.
--
-- calldesk.card_time   one line per customer opened by an agent on their own list: opened_at -> closed_at
--                      (closed when the agent opens the next customer, leaves the page or signs out).
-- public.cd_card_open(p_id)   the agent opened a customer (closes the agent's previous open one)
-- public.cd_card_close(p_card) the agent left the customer
-- public.cd_alerts()           team lead: agents on one customer for 12+ minutes (not yet acknowledged)
-- public.cd_alert_ack(p_card)  team lead: "seen"
-- No timers run in the database: the lead's page asks cd_alerts() once a minute.

create table if not exists calldesk.card_time (
  id         bigserial primary key,
  queue_id   bigint,
  agent_id   int not null,
  phone      text,
  client     text,
  opened_at  timestamptz not null default now(),
  closed_at  timestamptz,
  alerted_at timestamptz,
  acked_at   timestamptz,
  acked_by   text
);
create index if not exists card_time_open on calldesk.card_time (agent_id) where closed_at is null;
create index if not exists card_time_day on calldesk.card_time (opened_at);
revoke all on calldesk.card_time from public, anon, authenticated;
grant select on calldesk.card_time to vb_loader;

create or replace function public.cd_card_open(p_id bigint)
 returns bigint language plpgsql security definer set search_path to 'calldesk', 'public' as $$
declare m calldesk.agents := calldesk.me(); q calldesk.queue; nid bigint;
begin
  if m.id is null then raise exception 'not allowed' using errcode = '42501'; end if;
  update calldesk.card_time set closed_at = now() where agent_id = m.id and closed_at is null;
  select * into q from calldesk.queue where id = p_id and agent_id = m.id;   -- only the agent's own customers are timed
  if q.id is null then return null; end if;
  insert into calldesk.card_time (queue_id, agent_id, phone, client) values (q.id, m.id, q.phone, q.client) returning id into nid;
  return nid;
end $$;

create or replace function public.cd_card_close(p_card bigint)
 returns void language plpgsql security definer set search_path to 'calldesk', 'public' as $$
declare m calldesk.agents := calldesk.me();
begin
  if m.id is null then return; end if;
  update calldesk.card_time set closed_at = now() where id = p_card and agent_id = m.id and closed_at is null;
end $$;

create or replace function public.cd_alerts()
 returns jsonb language plpgsql security definer set search_path to 'calldesk', 'public' as $$
declare m calldesk.agents := calldesk.me(); res jsonb;
begin
  if m.id is null or m.role <> 'lead' then raise exception 'not allowed' using errcode = '42501'; end if;
  -- a card left open for more than 3 hours is a closed browser, not an agent at work
  update calldesk.card_time set closed_at = opened_at + interval '3 hours' where closed_at is null and opened_at < now() - interval '3 hours';
  update calldesk.card_time set alerted_at = now()
   where closed_at is null and acked_at is null and alerted_at is null and opened_at <= now() - interval '12 minutes';
  select coalesce(jsonb_agg(jsonb_build_object('card', c.id, 'agent', a.name, 'client', c.client, 'phone', c.phone,
           'opened_at', c.opened_at, 'minutes', floor(extract(epoch from now() - c.opened_at) / 60)::int) order by c.opened_at), '[]')
    into res
    from calldesk.card_time c join calldesk.agents a on a.id = c.agent_id
   where c.closed_at is null and c.acked_at is null and c.opened_at <= now() - interval '12 minutes';
  return res;
end $$;

create or replace function public.cd_alert_ack(p_card bigint)
 returns void language plpgsql security definer set search_path to 'calldesk', 'public' as $$
declare m calldesk.agents := calldesk.me();
begin
  if m.id is null or m.role <> 'lead' then raise exception 'not allowed' using errcode = '42501'; end if;
  update calldesk.card_time set acked_at = now(), acked_by = m.email where id = p_card;
end $$;

revoke all on function public.cd_card_open(bigint), public.cd_card_close(bigint), public.cd_alerts(), public.cd_alert_ack(bigint) from public;
grant execute on function public.cd_card_open(bigint), public.cd_card_close(bigint), public.cd_alerts(), public.cd_alert_ack(bigint) to anon, authenticated;
