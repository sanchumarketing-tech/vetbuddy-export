-- live definition of public.cd_agent_delete(p_id integer) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_agent_delete(p_id integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
-- 24 Nov 2026: a team lead deletes an agent. With no call history the agent is removed for good; with history
-- (list rows, calls) the agent is switched off and hidden from the Agents tab, so past calls, KPIs and
-- incentives keep their name. Either way they are signed out and today's numbers go back to the others.
declare m calldesk.agents := calldesk.me(); a calldesk.agents; hist boolean;
begin
  if m.role is distinct from 'lead' then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into a from calldesk.agents where id = p_id and deleted_at is null;
  if a.id is null then raise exception 'This agent no longer exists - reload the page'; end if;
  if a.id = m.id then raise exception 'You cannot delete yourself'; end if;
  if a.role = 'lead' and not exists (select 1 from calldesk.agents where role = 'lead' and active and deleted_at is null and id <> a.id) then
    raise exception 'This is the only team lead - add another team lead first';
  end if;
  delete from calldesk.sessions where agent_id = a.id;
  -- today's untouched numbers go back to the pool before the agent goes
  update calldesk.queue set agent_id = null
   where agent_id = a.id and list_date >= calldesk.today() and dialed_at is null and called_at is null and outcome is null and note is null;
  hist := exists (select 1 from calldesk.queue where agent_id = a.id) or exists (select 1 from calldesk.card_time where agent_id = a.id);
  if hist then
    update calldesk.agents set active = false, deleted_at = now(), pin_hash = null where id = a.id;
  else
    delete from calldesk.agents where id = a.id;
  end if;
  begin perform calldesk.rebalance_today(); exception when others then raise warning 'rebalance_today failed: %', sqlerrm; end;
  return jsonb_build_object('name', a.name, 'removed', case when hist then 'hidden (call history kept)' else 'deleted' end);
end $function$
;
