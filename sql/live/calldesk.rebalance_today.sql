-- live definition of calldesk.rebalance_today(p_day date, p_full boolean) - exported from the database
CREATE OR REPLACE FUNCTION calldesk.rebalance_today(p_day date DEFAULT NULL::date, p_full boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'calldesk', 'public'
AS $function$
declare
  d date := coalesce(p_day, calldesk.today());
  released int := 0; placed int := 0; pulled int := 0; k int;
  ag record; r record; a int; need int; bal jsonb;
begin
  if not exists (select 1 from calldesk.queue where list_date = d) then
    return jsonb_build_object('day', d, 'skipped', 'no list for this day yet');
  end if;
  create temp table if not exists t_rb (id int primary key, units text[], target int, n int) on commit drop;
  truncate t_rb;
  -- only active agents (role agent, target above 0) get numbers - never team leads
  insert into t_rb select g.id, g.units, g.daily_target,
         (select count(*) from calldesk.queue q where q.list_date = d and q.agent_id = g.id)::int
    from calldesk.agents g where g.active and not calldesk.is_off(g.id, d) and g.role = 'agent' and g.daily_target > 0 and g.department in (select name from calldesk.departments where calls);

  -- 1. untouched rows held by a team lead, an inactive agent, or an agent whose units do not include the row's unit: released
  with x as (
    update calldesk.queue q set agent_id = null
     where q.list_date = d and q.agent_id is not null
       and q.called_at is null and q.dialed_at is null and q.attempted_at is null and q.skipped_at is null
       and q.outcome is null and q.note is null
       and not exists (select 1 from t_rb b where b.id = q.agent_id and (b.units = '{}' or q.unit = any (b.units) or calldesk.home_ok(b.units, q.unit, q.reasons)))
    returning 1)
  select count(*) into released from x;
  update t_rb b set n = (select count(*) from calldesk.queue q where q.list_date = d and q.agent_id = b.id);

  -- 2. unassigned rows go to an allowed agent with room (agents with units first)
  for r in select q.id, q.unit from calldesk.queue q where q.list_date = d and q.agent_id is null order by q.rank, q.score desc nulls last, q.id loop
    a := null;
    select id into a from t_rb where n < target and (units = '{}' or r.unit = any (units))
     order by (units = '{}'), n::numeric / target, id limit 1;
    continue when a is null;
    update calldesk.queue set agent_id = a where id = r.id;
    update t_rb set n = n + 1 where id = a;
    placed := placed + 1;
  end loop;

  -- 3. agents with units still under target (e.g. added today): take untouched rows of their units from "Any" agents, most urgent first
  for ag in select * from t_rb where units <> '{}' and n < target order by n::numeric / target, id loop
    need := ag.target - ag.n;
    with pick as (
      select q.id from calldesk.queue q join t_rb h on h.id = q.agent_id and h.units = '{}'
       where q.list_date = d and q.unit = any (ag.units)
         and q.called_at is null and q.dialed_at is null and q.attempted_at is null and q.skipped_at is null
         and q.outcome is null and q.note is null
       order by q.rank, q.score desc nulls last, q.id limit need),
    upd as (update calldesk.queue q set agent_id = ag.id from pick where q.id = pick.id returning 1)
    select count(*) into k from upd;
    pulled := pulled + k;
  end loop;
  update t_rb b set n = (select count(*) from calldesk.queue q where q.list_date = d and q.agent_id = b.id);

  -- 4. full run: top everyone up to target (follow-ups, check-ins) and trim anyone over target
  if p_full then bal := calldesk.balance_lists(d); end if;
  return jsonb_build_object('day', d, 'released', released, 'placed', placed, 'pulled_from_any', pulled, 'balance', bal,
           'short', (select coalesce(jsonb_object_agg(g.name, b.target - b.n), '{}') from t_rb b join calldesk.agents g on g.id = b.id where b.n < b.target));
end $function$
;
