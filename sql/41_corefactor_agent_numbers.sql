-- 25 Nov 2026: the Corefactor download is switched off; the webhook only sends the agent's NUMBER (from_number /
-- to_number). Incentives and KPIs match calls to agents by NAME (calls.agent = agents.name), so:
--   calldesk.cf_agent_numbers(number -> name), learned from the calls both the download and the webhook had
--   (same customer, start within 2 minutes), and cf_webhook stores the name (number kept when unknown).
create table if not exists calldesk.cf_agent_numbers (
  number   text primary key,          -- last 10 digits
  name     text not null,
  calls    int,
  learned_at timestamptz default now()
);

create or replace function calldesk.cf_agent_learn() returns int language plpgsql security definer
set search_path to 'calldesk','public' as $$
declare n int;
begin
  with pairs as (
    select right(regexp_replace(r.body->>'from_number', '\D', '', 'g'), 10) number, k.agent name, count(*) c
      from calldesk.cf_live_raw r
      join calldesk.calls k on k.source = 'Corefactor' and k.call_key not like 'live:%'
       and k.agent is not null and k.agent !~ '^\+?\d+$' and k.agent not in ('UNKNOWN', '')
       and k.phone = right(regexp_replace(coalesce(nullif(r.body->>'to_number', ''), r.body->>'lead_mobile'), '\D', '', 'g'), 10)
       and k.call_at between (r.body->>'start_time')::timestamp - interval '2 minutes' and (r.body->>'start_time')::timestamp + interval '2 minutes'
     where r.kind = 'call' and r.body ? 'unique_id' and r.body->>'direction' ilike 'out%'
       and coalesce(r.body->>'from_number', '') <> '' and (r.body->>'start_time') ~ '^\d{4}-\d{2}-\d{2} '
     group by 1, 2),
  best as (select distinct on (number) number, name, c from pairs where length(number) = 10 order by number, c desc)
  insert into calldesk.cf_agent_numbers (number, name, calls)
  select number, name, c from best where c >= 3
  on conflict (number) do update set name = excluded.name, calls = excluded.calls, learned_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

-- the webhook: agent = name when the number is known (patched into public.cf_webhook after the agent number is read)
--   v_agent := coalesce((select name from calldesk.cf_agent_numbers where number = right(regexp_replace(v_agent, '\D', '', 'g'), 10)), v_agent);
-- and the live rows already saved get their names:
--   update calldesk.calls k set agent = m.name from calldesk.cf_agent_numbers m
--    where k.call_key like 'live:%' and right(regexp_replace(k.agent, '\D', '', 'g'), 10) = m.number;
