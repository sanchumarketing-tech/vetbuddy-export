-- 51  Call Desk: every agent on the Agent dashboard (27 Nov 2026)
-- Corefactor's webhook sends only the caller's NUMBER and Runo only the LINE name. The dashboard matched numbers to
-- agents from customer cards, so agents who don't open cards (VOW, Incoming, Chat, Social Media) never showed.
-- Now a team lead gives each agent their Corefactor number(s) / Runo line(s) in Agents ("Corefactor number / Runo line").
--   calldesk.agents.call_ids        what the lead typed, normalised (number -> last 10 digits, line -> lower case)
--   calldesk.agent_call_ids         lookup id -> agent (one agent per id), used by cd_agent_calls
--   public.cd_agent_ids(p_id, p_ids, p_email)   team leads; p_id null = the agent just added, found by email
-- Live patches (applied with pg_get_functiondef + replace):
--   cd_team: lists a.call_ids per agent
--   cd_agent_calls: from calldesk.calls k left join (select ci.id, ca.name from calldesk.agent_call_ids ci
--       join calldesk.agents ca on ca.id = ci.agent_id) am on am.id = (case when k.agent ~ '^\+?[0-9 -]{10,}$'
--       then right(regexp_replace(k.agent, '\D', '', 'g'), 10) else lower(trim(k.agent)) end)
--     and each call's agent is coalesce(am.name, k.agent)
alter table calldesk.agents add column if not exists call_ids text[] not null default '{}';
create table if not exists calldesk.agent_call_ids (
  id       text primary key,
  agent_id int not null references calldesk.agents (id) on delete cascade
);
revoke all on calldesk.agent_call_ids from public, anon, authenticated;

create or replace function public.cd_agent_ids(p_id int, p_ids text, p_email text default null) returns jsonb
language plpgsql volatile security definer set search_path = calldesk, public as $f$
declare m calldesk.agents := calldesk.me(); ids text[]; clash text; aid int := p_id;
begin
  if m.role is distinct from 'lead' then raise exception 'not allowed' using errcode = '42501'; end if;
  if aid is null then select id into aid from calldesk.agents where email = lower(trim(p_email)) and deleted_at is null; end if;
  if aid is null then raise exception 'This agent no longer exists - reload the page'; end if;
  select coalesce(array_agg(distinct v) filter (where v <> ''), '{}') into ids from (
    select case when length(regexp_replace(x, '\D', '', 'g')) >= 10 and x !~ '[A-Za-z]' then right(regexp_replace(x, '\D', '', 'g'), 10)
                else lower(regexp_replace(trim(x), '\s+', ' ', 'g')) end v
      from unnest(regexp_split_to_array(coalesce(p_ids, ''), '[,;\n]+')) x) s;
  select a.name || ' (' || ci.id || ')' into clash from calldesk.agent_call_ids ci join calldesk.agents a on a.id = ci.agent_id
   where ci.agent_id <> aid and a.deleted_at is null and ci.id = any (ids) limit 1;
  if clash is not null then raise exception 'Already given to %', clash; end if;
  update calldesk.agents set call_ids = ids where id = aid and deleted_at is null;
  delete from calldesk.agent_call_ids where agent_id = aid or id = any (ids);
  insert into calldesk.agent_call_ids (id, agent_id) select unnest(ids), aid;
  return jsonb_build_object('ok', true, 'ids', to_jsonb(ids));
end $f$;
revoke all on function public.cd_agent_ids(int, text, text) from public;
grant execute on function public.cd_agent_ids(int, text, text) to anon, authenticated;
