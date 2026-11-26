-- live definition of public.cd_agent_off(p_id integer, p_day date, p_off boolean) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_agent_off(p_id integer, p_day date, p_off boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
-- 24 Nov 2026: team lead marks an agent's week off (no numbers that day; they can still sign in).
-- Marking today off sends their untouched numbers to the other agents at once.
declare m calldesk.agents := calldesk.me(); a calldesk.agents;
begin
  if m.role is distinct from 'lead' then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into a from calldesk.agents where id = p_id and deleted_at is null;
  if a.id is null then raise exception 'This agent no longer exists - reload the page'; end if;
  if p_day is null or p_day < calldesk.today() then raise exception 'Pick today or a later day'; end if;
  if p_off then
    insert into calldesk.agent_off (agent_id, day, set_by) values (a.id, p_day, m.name) on conflict (agent_id, day) do nothing;
    if p_day = calldesk.today() then
      update calldesk.queue set agent_id = null
       where agent_id = a.id and list_date = p_day and dialed_at is null and called_at is null and outcome is null and note is null;
      begin perform calldesk.rebalance_today(); exception when others then raise warning 'rebalance_today failed: %', sqlerrm; end;
    end if;
  else
    delete from calldesk.agent_off where agent_id = a.id and day = p_day;
    if p_day = calldesk.today() then
      begin perform calldesk.rebalance_today(); exception when others then raise warning 'rebalance_today failed: %', sqlerrm; end;
    end if;
  end if;
  return jsonb_build_object('name', a.name, 'off', coalesce((select jsonb_agg(day order by day) from calldesk.agent_off where agent_id = a.id and day >= calldesk.today()), '[]'::jsonb));
end $function$
;
