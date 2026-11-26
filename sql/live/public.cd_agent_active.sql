-- live definition of public.cd_agent_active(p_id integer, p_active boolean) - exported from the database
CREATE OR REPLACE FUNCTION public.cd_agent_active(p_id integer, p_active boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
-- 24 Nov 2026: team lead switches an agent active / inactive. Inactive: signed out, cannot sign in, gets no numbers;
-- today's untouched numbers go to the other agents. Active again: can sign in and gets numbers from the next allocation.
declare m calldesk.agents := calldesk.me(); a calldesk.agents;
begin
  if m.role is distinct from 'lead' then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into a from calldesk.agents where id = p_id and deleted_at is null;
  if a.id is null then raise exception 'This agent no longer exists - reload the page'; end if;
  if a.id = m.id and not p_active then raise exception 'You cannot switch yourself off'; end if;
  if a.role = 'lead' and not p_active and not exists (select 1 from calldesk.agents where role = 'lead' and active and deleted_at is null and id <> a.id) then
    raise exception 'This is the only team lead - add another team lead first';
  end if;
  update calldesk.agents set active = p_active where id = a.id;
  if not p_active then
    delete from calldesk.sessions where agent_id = a.id;
    update calldesk.queue set agent_id = null
     where agent_id = a.id and list_date >= calldesk.today() and dialed_at is null and called_at is null and outcome is null and note is null;
  end if;
  begin perform calldesk.rebalance_today(); exception when others then raise warning 'rebalance_today failed: %', sqlerrm; end;
  return jsonb_build_object('name', a.name, 'active', p_active);
end $function$
;
